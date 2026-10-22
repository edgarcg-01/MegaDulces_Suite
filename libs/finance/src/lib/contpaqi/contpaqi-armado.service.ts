import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  CONTPAQI_POLIZA_SINK_PORT, type ContpaqiPolizaSinkPort,
} from '@megadulces/contracts';
import { AlcanceTenant } from './alcance-tenant';
import { compararArchivo, filasDeEntrega, huellaArchivo, type LoteArchivo } from './entrega';
import { esFirmable, PREFIJO_GASTO, validarFirma, validarRevocacion, type CuentaCatalogo } from './firma-regla';

/**
 * `[CP.8.52]` La entrega se niega con un motivo que quien marca tiene que leer (archivo distinto,
 * sin autor). El controlador la traduce a 409/400; cualquier otro error es nuestro.
 */
export class EntregaRechazada extends Error {
  readonly code = 'entrega_rechazada';
}

/** `[CP.8.53]` Una firma o revocación que no procede, con el motivo para quien firma. */
export class FirmaRechazada extends Error {
  readonly code = 'firma_rechazada';
}

/** `[CP.8.73]` Una confirmación de pago que no procede (no cuadra, facturas de otro proveedor…), con su motivo. */
export class ConfirmacionRechazada extends Error {
  readonly code = 'confirmacion_rechazada';
}

/** `[CP.8.73]` Un pago a proveedor que no se armó solo, con lo que hace falta para confirmarlo. */
export interface PagoPorConfirmar {
  movimiento_id: string;
  fecha: string;
  cuenta_banco: string;
  banco_label: string | null;
  importe: number;
  concepto: string;
  /** Por qué no se armó solo. */
  motivo: string;
  /** `null` = no se sabe de quién es: no se puede confirmar desde aquí. */
  propuesta: PropuestaPago | null;
  /** La confirmación vigente, si ya hay una. */
  confirmacion: { facturas: string[]; notas: string[]; confirmado_por: string; vigente: boolean } | null;
}

/** Una fila de `contpaqi.pago_confirmaciones` tal como la lee el armado. */
interface FilaConfirmacion {
  bank_movement_id: string;
  facturas: string[];
  notas: string[];
  pagado: string | number;
  confirmado_por: string;
}

/** Una fila de `contpaqi.account_rules` tal como la lee `reglas()`. */
interface FilaRegla {
  categoria_code: string;
  tipo_regla: string;
  estado: string;
  cuenta_gasto: string | null;
  cuenta_nombre: string | null;
  aprobada_por: string | null;
  aprobada_en: string | null;
  concepto_medido: string | null;
  forma_medida: { candidata?: string; salvedad?: string; pareados?: number } | null;
}

/** `[CP.8.53]` Una regla como la ve el contador: qué es, cuánto pesa este mes, y su evidencia. */
export interface ReglaVista {
  categoria_code: string;
  tipo_regla: string;
  estado: string;
  /** `false` si la categoría tiene egresos pero ninguna fila en `account_rules`. */
  tiene_fila: boolean;
  cuenta_gasto: string | null;
  cuenta_nombre: string | null;
  aprobada_por: string | null;
  aprobada_en: string | null;
  firmable: boolean;
  motivo_no_firmable: string | null;
  /** ⛔ Indicio del derivador, NUNCA una propuesta aplicada: la pantalla no la preselecciona. */
  indicio: string | null;
  evidencia: string | null;
  salvedad: string | null;
  pareados: number | null;
  movimientos_mes: number;
  importe_mes: number;
}
import {
  armarAsientoEgreso, armarLoteEgresos, AsientoRechazado, type ReglaCuenta,
} from './poliza-egreso';
import { tokenDe } from './token';
import { armarPagoProveedorCompleto } from './pago-proveedor';
import {
  FuentePagoProveedor, type FuenteFacturas, type MovimientoPago, type PropuestaPago, type ResolucionPago,
} from './pago-proveedor.fuente';
import type { EventoArchivo } from './entrega';
import {
  construirIndice, resolverProveedor, normalizarNombre, palabrasEnComun,
  type AliasProveedor, type CuentaProveedor, type IndiceProveedores,
} from './proveedor-resolver';

/**
 * Fase CP `[CP.8.7]` — **El eslabón que faltaba: de un movimiento bancario a una póliza.**
 *
 * Sin esto, `contpaqi.poliza_exports` queda vacía para siempre y el cuadre no tiene qué cuadrar.
 * Lee los egresos clasificados de la Fase CB, busca su regla, arma el asiento, lo entrega por el
 * puerto y deja el registro.
 *
 * ── ⭐ El modelo de entrada, MEDIDO y no supuesto ───────────────────────────────────────────
 * Lo primero que hay que entender es que **el IVA NO viene en el mismo renglón**. El banco cobra
 * el gasto y su impuesto como dos movimientos distintos:
 *
 *     "ADM PAQUETE PYME"  ->  490.00      (categoría del gasto)
 *     "IVA"               ->   78.40      (categoría `iva_acreditable`)   490 × 0.16 = 78.40
 *
 * Por eso CB tiene 4,632 movimientos en `iva_acreditable`. Medido el 2026-10-09 contra prod:
 *
 * | | |
 * |---|--:|
 * | IVA con hermano exacto (misma cuenta, misma fecha, ×0.16) | **76.8%** |
 * | ambiguos (más de un candidato) | 1.5% |
 * | ⭐ **placebo** (fecha corrida 43 días) | **0.1%** |
 *
 * **768× el piso de ruido.** El pareo es real, no una coincidencia aritmética.
 *
 * ⚠️ Y el 23.2% sin hermano **se declara, no se inventa**: puede ser gasto exento, IVA cobrado
 * otro día, o un cargo que ya viene con impuesto adentro. Esos se arman con IVA 0 y el motivo
 * escrito — nunca calculando un 16% que nadie cobró.
 *
 * ⛔ **Y no hay atajo por CFDI**: `bank_movements.client_uuid` parece un UUID pero es la llave de
 * idempotencia del importer (SHA-1); **0 de ellas cruzan con `fiscal.cfdis`**. El desglose sale
 * del banco o no sale.
 *
 * ── Qué hace hoy, que es negarse ────────────────────────────────────────────────────────────
 * Las 19 reglas están en `sin_regla` (`[CP.8.1c]`): el mapa categoría→cuenta no es derivable y lo
 * firma el contador. Así que **hoy este servicio rechaza todo, con motivo**. Eso no es una falla
 * a medias: es el comportamiento correcto, es testeable, y el día que se firme una regla empieza
 * a asentar sin tocar una línea de código.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * `[CP.8.21]` — Un lote = una póliza candidata, al grano real (cuenta de banco × día).
 * `motivos` lleva el conteo **por motivo**, no un total: cuatro rechazos distintos tienen cuatro
 * dueños distintos y colapsarlos a "N rechazadas" borra justamente la información accionable.
 */
export interface ResumenLote {
  cuenta_banco: string;
  /**
   * Cómo lo nombra finanzas (`BBAJIO 4166`). ⚠️ Viaja además de la cuenta contable, no en vez
   * de ella: la pantalla no debe inventar el alias, y una cuenta mal rotulada en contabilidad
   * es peor que una cuenta sin rótulo.
   */
  banco_label: string | null;
  fecha: string;
  movimientos: number;
  incluidas: number;
  renglones: number;
  total: number;
  /** `'no_emitido'` = el lote cuadra pero le falta el traspaso de impuesto. Se declara. */
  iva_traspaso: 'no_emitido' | null;
  motivos: Record<string, number>;
  /**
   * `[CP.8.72]` `pago_proveedor` = un pago a proveedor armado COMPLETO, una póliza por pago (como la hace la
   * contadora). Ausente o `lote` = el lote del día. Los pagos que no se arman se cuentan en `motivos` de su
   * lote (`pago_a_confirmar`, `pago_sin_resolver`, `pago_no_cuadra`…), nunca entran al lote como «2120 / banco».
   */
  tipo?: 'lote' | 'pago_proveedor';
  /** De dónde salieron las facturas del pago: la cadena de Kepler o una factura por importe. */
  fuente?: FuenteFacturas | null;
  /** Facturas y notas (UUID) que lleva el pago: van a los renglones `AD` del archivo. */
  cfdis?: number;
  /** Identidad de la fila: `cuenta|fecha` del lote o `pago|<id del movimiento>`. Un pago y su día comparten banco y fecha. */
  clave?: string;
}

/** Lo que arma `construirLotes`: el resumen para la pantalla y el asiento para el archivo, con su identidad. */
interface PolizaArmada {
  resumen: ResumenLote;
  asiento: ReturnType<typeof armarLoteEgresos>['asiento'];
  evento_tipo: EventoArchivo;
  /** `cuenta_banco|fecha` del lote, o el id del movimiento del pago. */
  clave: string;
  uuids: string[];
}

/**
 * `[CP.8.34]` — **Lo que el puente NO cubre, dicho por el servidor.**
 *
 * ⛔ Antes esto vivía en un `logger.warn` que nadie lee: *"876 egresos sin contpaqi_cuenta"*.
 * La bandeja publicaba 1,474 como si fuera el universo del mes, y el universo real de enero es
 * **2,350** — un denominador recortado en 37.3 %, el mismo defecto que esta fase le corrigió al
 * `0 %` del cuadre.
 *
 * ⚠️ **Y la causa no es la que el `warn` sugería.** Medido el 2026-10-09: los 876 **sí tienen
 * cuenta**; son `CAJA CG` (864) y `FACTORAJE FAC` (12), que **no son bancos** y por eso no
 * tienen cuenta `102*` que ponerles. No es un mapeo que falte: es un circuito distinto, fuera
 * del alcance de un puente de egresos de banco. Se declara con nombre e importe para que nadie
 * lo lea como trabajo pendiente ni como cero.
 */
export interface CuentaFueraDeLote {
  /** Como la conoce finanzas: `CAJA CG`, `FACTORAJE FAC`. */
  cuenta: string;
  movimientos: number;
  importe: number;
}

/** Lo que devuelve la simulación de un mes: los lotes **y** lo que quedó fuera de todo lote. */
export interface ResumenMes {
  lotes: ResumenLote[];
  fuera_de_lote: {
    movimientos: number;
    importe: number;
    cuentas: CuentaFueraDeLote[];
  };
}

/** `[CP.8.37]` Un nombre del banco que todavía no llega a una cuenta, con sus pistas. */
export interface PendienteProveedor {
  alias_normalizado: string;
  concepto_banco: string;
  movimientos: number;
  importe: number;
  veredicto: string;
  motivo: string | null;
  rubro: string;
  /** ⛔ Pistas por palabras en común. Nunca se aplican solas. */
  sugerencias: { cuenta: string; nombre: string; veredicto: string; parecido: number }[];
}

export interface ResultadoArmado {
  evento_id: string;
  estado: 'entregada' | 'rechazada';
  motivo: string;
  /** El archivo, cuando el sink es `txt` y el asiento se armó. */
  archivo?: { nombre: string; contenido: string };
}

@Injectable()
export class ContpaqiArmadoService {
  private readonly log = new Logger(ContpaqiArmadoService.name);

  constructor(
    @Inject('KNEX_NEW_DB') private readonly pool: Knex,
    @Optional() @Inject(CONTPAQI_POLIZA_SINK_PORT) private readonly sink?: ContpaqiPolizaSinkPort,
  ) {}

  /**
   * ⛔⛔ `[CP.8.58]` — **Toda lectura y escritura pasa por `conTenant()`.** Las siete tablas que
   * este servicio toca tienen RLS forzado y la API corre como `app_runtime`, sin tenant por
   * default: sin fijarlo, la bandeja sale vacía sin error. Ver `alcance-tenant.ts`. Candado:
   * `test-newdb-contpaqi-tenant.js`.
   */
  private readonly alcance = new AlcanceTenant();

  private get db(): Knex {
    return this.alcance.db;
  }

  private conTenant<T>(fn: () => Promise<T>): Promise<T> {
    return this.alcance.run(this.pool, MEGA, fn);
  }

  /**
   * Arma (y entrega, si hay sink) los egresos de un periodo.
   *
   * `soloSimular` deja ver qué pasaría sin escribir nada — es lo que la bandeja va a usar para
   * mostrar el "qué entraría" antes de que alguien apriete nada.
   */
  async armarPeriodo(anioMes: string, soloSimular = true): Promise<ResultadoArmado[]> {
    return this.conTenant(() => this.armarPeriodoEnAlcance(anioMes, soloSimular));
  }

  private async armarPeriodoEnAlcance(anioMes: string, soloSimular: boolean): Promise<ResultadoArmado[]> {
    const egresos = await this.leerEgresos(anioMes);
    const reglas = await this.leerReglas();
    const out: ResultadoArmado[] = [];

    for (const e of egresos) {
      const regla = reglas.get(e.categoria_code);
      const evento_id = String(e.id);

      if (!regla) {
        out.push({ evento_id, estado: 'rechazada',
          motivo: `la categoría "${e.categoria_code}" no tiene fila en contpaqi.account_rules` });
        continue;
      }
      if (!e.cuenta_banco) {
        // El crosswalk de CP.2 enlazó 16 de 18 cuentas. Las 2 que faltan no se adivinan.
        out.push({ evento_id, estado: 'rechazada',
          motivo: `la cuenta de banco "${e.banco_label}" no tiene contpaqi_cuenta (crosswalk de CP.2)` });
        continue;
      }

      const subtotal = Number(e.amount_out);
      const iva = Number(e.iva_hermano ?? 0);
      try {
        const asiento = armarAsientoEgreso({
          regla,
          subtotal,
          iva,
          total: Math.round((subtotal + iva) * 100) / 100,
          cuenta_banco: e.cuenta_banco,
          concepto: String(e.concept ?? '').trim() || e.categoria_nombre,
          fecha: e.fecha,
          seg_negocio: 0, // ⚠️ CB no trae segmento por movimiento; omitir es mejor que inventar.
        });

        const token = tokenDe('bank_movement', evento_id);
        if (soloSimular || !this.sink) {
          out.push({ evento_id, estado: 'entregada',
            motivo: this.sink ? 'simulación: el asiento cuadra y se podría entregar'
              : 'el asiento cuadra, pero no hay sink conectado' });
          continue;
        }

        const r = await this.sink.entregar({
          evento_tipo: 'bank_movement', evento_id,
          tipo_poliza: asiento.tipo_poliza, fecha: asiento.fecha, concepto: asiento.concepto,
          movimientos: asiento.movimientos, total: asiento.total, token,
        });
        await this.registrar(evento_id, anioMes, asiento, token, r.estado, r.motivo ?? '');
        out.push({ evento_id, estado: r.estado, motivo: r.motivo ?? 'entregada', archivo: r.archivo });
      } catch (err) {
        // `AsientoRechazado` trae el motivo tipado; cualquier otra cosa se reporta cruda.
        const motivo = err instanceof AsientoRechazado ? `${err.motivo}: ${err.message}`
          : (err instanceof Error ? err.message : String(err));
        out.push({ evento_id, estado: 'rechazada', motivo });
      }
    }

    const entregadas = out.filter((x) => x.estado === 'entregada').length;
    this.log.log(`armado ${anioMes}: ${entregadas}/${out.length} armables${soloSimular ? ' (simulación)' : ''}`);
    return out;
  }

  /**
   * Los egresos del periodo con su categoría, su cuenta de banco en ContPAQi, y **su hermano de
   * IVA** si existe.
   *
   * ⚠️ El `LEFT JOIN LATERAL` del IVA lleva `LIMIT 1` y ordena por el id: en el 1.5% de casos con
   * más de un candidato hay que elegir uno, y elegir **siempre el mismo** es lo que vuelve
   * reproducible el resultado. La alternativa —rechazar los ambiguos— se descartó porque el
   * armador ya rechaza por falta de regla; sumar un segundo motivo para el 1.5% no cambia nada
   * hoy y sí esconde el que importa.
   *
   * ⭐ `[CP.8.75]` El mes va por RANGO (`>= día 1 AND < día 1 + 1 mes`), no por
   * `to_char(...) = ?`: el `to_char` en el WHERE anulaba el índice `(tenant, cuenta, fecha)` y la
   * consulta recorría la tabla entera una vez por categoría. Y el IVA hermano se calcula UNA vez
   * por (cuenta, día, importe) con `DISTINCT ON ... ORDER BY id` —el mismo «el de menor id»— en vez
   * de un `LATERAL` por renglón. Medido en el servidor (`EXPLAIN ANALYZE`, `TIMING OFF`) contra
   * prod: **974 → 58 ms** (mediana de 6, alternadas), y filas idénticas en 12 meses.
   */
  private async leerEgresos(anioMes: string): Promise<any[]> {
    const dia1 = `${anioMes}-01`;
    return this.db
      .with('iva', (q) => q
        .select(this.db.raw(`DISTINCT ON (h.bank_account_id, h.movement_date, round(h.amount_out, 2))
            h.bank_account_id, h.movement_date, round(h.amount_out, 2) AS r, h.amount_out`))
        .from('finance.bank_movements as h')
        .join('finance.movement_categories as hc', 'hc.id', 'h.category_id')
        .where('h.tenant_id', MEGA)
        .whereNull('h.deleted_at')
        .where('hc.code', 'iva_acreditable')
        .whereRaw(`h.movement_date >= ?::date AND h.movement_date < (?::date + interval '1 month')`, [dia1, dia1])
        .orderByRaw('h.bank_account_id, h.movement_date, round(h.amount_out, 2), h.id'))
      .select(
        'm.id', 'm.concept', 'm.amount_out',
        this.db.raw(`to_char(m.movement_date, 'YYYY-MM-DD') as fecha`),
        'c.code as categoria_code', 'c.name as categoria_nombre',
        'ba.contpaqi_cuenta as cuenta_banco', 'ba.account_label as banco_label',
        // `[CP.8.34]` El nombre del banco viaja para poder NOMBRAR lo que queda fuera de lote:
        // `CAJA CG` y `FACTORAJE FAC` se leen solos; un `CG` suelto no lo entiende nadie.
        'ba.bank as banco_nombre',
        this.db.raw('iva.amount_out as iva_hermano'),
      )
      .from('finance.bank_movements as m')
      .join('finance.movement_categories as c', 'c.id', 'm.category_id')
      .leftJoin('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
      .joinRaw(`
        LEFT JOIN iva ON iva.bank_account_id = m.bank_account_id
                     AND iva.movement_date   = m.movement_date
                     AND iva.r = round(m.amount_out * 0.16, 2)`)
      .where('m.tenant_id', MEGA)
      .whereNull('m.deleted_at')
      .where('m.amount_out', '>', 0)
      // El IVA no se arma solo: es el renglón 2 del asiento de su hermano.
      .whereNot('c.code', 'iva_acreditable')
      .whereRaw(`m.movement_date >= ?::date AND m.movement_date < (?::date + interval '1 month')`, [dia1, dia1])
      .orderBy('m.movement_date')
      .orderBy('m.id');
  }

  /**
   * Las reglas, por código de categoría.
   *
   * ⭐ `[CP.8.19]` agregó `tipo_regla`: la cuenta de cargo no siempre la decide la categoría.
   * Leerlo acá es lo que hace que `no_aplica` (ya decidido) deje de verse igual que `sin_regla`
   * (falta decidir) — dos estados con dueños distintos.
   */
  /**
   * `[CP.8.35]` — Un índice de proveedores **por rubro**, uno por cada regla `por_proveedor`.
   *
   * ⛔ El rubro sale de `cuenta_prefijo` de la propia regla y no de una constante: ahí estuvo el
   * defecto que tuvo esto en 1.4 % de resolución. Las cuentas de proveedor viven en 2120, 5010 y
   * 5020; un PAGO carga a la de por pagar, y el mismo nombre existe en los tres rubros.
   */
  private async leerIndicesProveedor(
    reglas: Map<string, ReglaCuenta>,
  ): Promise<Map<string, IndiceProveedores>> {
    const prefijos = [...new Set([...reglas.values()]
      .filter((r) => r.tipo_regla === 'por_proveedor' && r.cuenta_prefijo)
      .map((r) => r.cuenta_prefijo as string))];
    if (!prefijos.length) return new Map();

    const filas = await this.db('contpaqi.supplier_accounts').where({ tenant_id: MEGA })
      .select('cuenta', 'proveedor_nombre', 'cuenta_nombre', 'veredicto', 'rfc');

    /**
     * `[CP.8.36]` Los alias que una persona confirmó. ⚠️ Si la tabla todavía no existe en este
     * destino, se sigue **sin** alias en vez de reventar: el resolvedor degrada a lo derivado,
     * que es exactamente lo que hacía antes.
     */
    let alias: AliasProveedor[] = [];
    try {
      // ⛔ `[CP.8.58]` En SAVEPOINT: ahora corre dentro de una transacción, y un error atrapado sin
      // savepoint deja la transacción abortada — todo lo que sigue moriría con 25P02.
      alias = await this.db.transaction((sp) => sp('contpaqi.supplier_aliases')
        .where({ tenant_id: MEGA, active: true })
        .select('alias_normalizado', 'cuenta'));
    } catch (e) {
      /**
       * ⛔ `[CP.8.39]` — **Las dos ausencias NO son la misma** (ADR-056), y este `catch` las
       * confundía: cualquier error se reportaba como *"no existe en este destino"*.
       *
       * Medido en prod: la tabla **sí existía** (batch 878) y lo que faltaba era el `GRANT` a
       * `app_runtime`, o sea `42501 permission denied`. El resolvedor degradaba al padrón sin
       * alias —comportamiento razonable para un destino viejo, **defecto** en producción— y el
       * log afirmaba un motivo falso, que es lo que lo volvía invisible.
       *
       *   `42P01` tabla ausente  → destino sin la migración: degradar es correcto.
       *   `42501` sin permiso    → la defensa está rota: se degrada igual (no se tumba el
       *                            armado entero) pero se grita `error`, no `warn`.
       */
      const code = (e as { code?: string })?.code;
      if (code === '42P01') {
        this.log.warn('contpaqi.supplier_aliases no existe en este destino: se resuelve sólo con el padrón');
      } else if (code === '42501') {
        this.log.error(
          '⛔ contpaqi.supplier_aliases existe pero el rol de la app NO puede leerla (42501): '
          + 'los alias confirmados NO se están aplicando. Falta el GRANT — ver migración [CP.8.39].');
      } else {
        this.log.error(
          `contpaqi.supplier_aliases ilegible (${code ?? 'sin código'}): se resuelve sólo con el padrón. `
          + `${(e as Error)?.message ?? e}`);
      }
    }

    const out = new Map<string, IndiceProveedores>();
    for (const p of prefijos) out.set(p, construirIndice(filas as CuentaProveedor[], p, alias));
    this.log.log(`índice de proveedores: ${filas.length} cuentas · ${alias.length} alias · rubros ${prefijos.join(', ')}`);
    return out;
  }

  /**
   * `[CP.8.37]` — **El trabajo pendiente de proveedores, agrupado por NOMBRE y ordenado por dinero.**
   *
   * ⭐ Agrupa a propósito: quien confirma no resuelve 72 movimientos, confirma **53 nombres**. Es
   * la diferencia entre una tarde y una hora.
   *
   * ⛔ Las sugerencias se ordenan por **palabras en común** y son una PISTA, no un veredicto. No
   * se aplican solas nunca: una cuenta equivocada **cuadra igual** y no se ve hasta la balanza.
   */
  async proveedoresPendientes(anioMes: string): Promise<PendienteProveedor[]> {
    return this.conTenant(() => this.proveedoresPendientesEnAlcance(anioMes));
  }

  private async proveedoresPendientesEnAlcance(anioMes: string): Promise<PendienteProveedor[]> {
    const egresos = await this.leerEgresos(anioMes);
    const reglas = await this.leerReglas();
    const indices = await this.leerIndicesProveedor(reglas);

    const padron = await this.db('contpaqi.supplier_accounts').where({ tenant_id: MEGA })
      .select('cuenta', 'proveedor_nombre', 'cuenta_nombre', 'veredicto');

    const pend = new Map<string, PendienteProveedor>();
    for (const e of egresos) {
      const regla = reglas.get(e.categoria_code);
      if (!regla || regla.tipo_regla !== 'por_proveedor' || !e.cuenta_banco) continue;
      const idx = regla.cuenta_prefijo ? indices.get(regla.cuenta_prefijo) : undefined;
      if (!idx) continue;
      const r = resolverProveedor(idx, e.concept);
      if (r.veredicto === 'resuelto') continue;

      const clave = normalizarNombre(e.concept) || '(sin concepto)';
      const y = pend.get(clave) ?? {
        alias_normalizado: clave,
        concepto_banco: String(e.concept ?? ''),
        movimientos: 0,
        importe: 0,
        veredicto: r.veredicto,
        motivo: r.motivo,
        rubro: regla.cuenta_prefijo ?? '2120',
        sugerencias: [],
      };
      y.movimientos += 1;
      y.importe = Math.round((y.importe + Number(e.amount_out)) * 100) / 100;
      pend.set(clave, y);
    }

    const filas = [...pend.values()].sort((a, b) => b.importe - a.importe);
    for (const f of filas) {
      f.sugerencias = padron
        .filter((p: any) => String(p.cuenta).startsWith(f.rubro))
        .map((p: any) => ({
          cuenta: p.cuenta,
          nombre: p.proveedor_nombre ?? p.cuenta_nombre ?? '',
          veredicto: p.veredicto,
          parecido: Math.max(
            palabrasEnComun(f.concepto_banco, p.proveedor_nombre),
            palabrasEnComun(f.concepto_banco, p.cuenta_nombre),
          ),
        }))
        .filter((s: any) => s.parecido >= 0.5)
        .sort((a: any, b: any) => b.parecido - a.parecido)
        .slice(0, 3);
    }
    return filas;
  }

  /**
   * Guarda un alias confirmado por una PERSONA.
   *
   * ⛔ Valida que la cuenta **exista en el catálogo de ContPAQi** y que sea del rubro: el CHECK de
   * la tabla sólo cuida la forma (10 dígitos), y una cuenta con forma válida que no existe se
   * importaría como basura.
   */
  async confirmarAlias(entrada: {
    concepto_banco: string; cuenta: string; rubro?: string; nota?: string; confirmado_por: string;
  }): Promise<{ alias_normalizado: string; cuenta: string }> {
    return this.conTenant(() => this.confirmarAliasEnAlcance(entrada));
  }

  private async confirmarAliasEnAlcance(entrada: {
    concepto_banco: string; cuenta: string; rubro?: string; nota?: string; confirmado_por: string;
  }): Promise<{ alias_normalizado: string; cuenta: string }> {
    const alias = normalizarNombre(entrada.concepto_banco);
    if (alias.length < 5) throw new Error('el concepto no deja un nombre con qué buscar');
    const rubro = entrada.rubro ?? '2120';
    if (!String(entrada.cuenta).startsWith(rubro)) {
      throw new Error(
        `la cuenta ${entrada.cuenta} no es del rubro ${rubro}: un alias a otro rubro sería una `
        + 'puerta trasera al defecto que costó 69 pp de resolución',
      );
    }
    const existe = await this.db('analytics.contpaqi_accounts')
      .where({ codigo: entrada.cuenta }).first();
    if (!existe) throw new Error(`la cuenta ${entrada.cuenta} no existe en el catálogo de ContPAQi`);
    if (!entrada.confirmado_por) throw new Error('un alias sin autor no es una afirmación');

    await this.db('contpaqi.supplier_aliases')
      .insert({
        tenant_id: MEGA,
        concepto_banco: entrada.concepto_banco,
        alias_normalizado: alias,
        cuenta: entrada.cuenta,
        cuenta_nombre: (existe as any).nombre ?? null,
        confirmado_por: entrada.confirmado_por,
        nota: entrada.nota ?? null,
      })
      .onConflict(this.db.raw('(tenant_id, alias_normalizado) WHERE active') as any)
      .merge({
        cuenta: entrada.cuenta,
        cuenta_nombre: (existe as any).nombre ?? null,
        nota: entrada.nota ?? null,
        updated_at: this.db.fn.now(),
        updated_by: entrada.confirmado_por,
      });
    this.log.log(`alias confirmado: "${alias}" → ${entrada.cuenta} (${entrada.confirmado_por})`);
    return { alias_normalizado: alias, cuenta: entrada.cuenta };
  }

  /**
   * `[CP.8.53]` — **Las reglas como las ve el contador**, ordenadas por cuánto dinero del mes
   * traban. ⭐ El orden es el trabajo: firmar primero la que más pesa.
   *
   * Incluye las categorías que tienen egresos y **ninguna fila** en `account_rules` (el armador
   * las trata como `sin_medir`): si no aparecieran acá, ese dinero quedaría trabado sin que nadie
   * sepa por qué.
   */
  async reglas(anioMes: string): Promise<ReglaVista[]> {
    return this.conTenant(async () => {
      const filas = await this.db('contpaqi.account_rules').where({ tenant_id: MEGA })
        .select('categoria_code', 'tipo_regla', 'estado', 'cuenta_gasto', 'cuenta_nombre',
          'aprobada_por', 'concepto_medido', 'forma_medida',
          this.db.raw(`to_char(aprobada_en AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') as aprobada_en`));
      const egresos = await this.leerEgresos(anioMes);
      const vol = new Map<string, { n: number; imp: number }>();
      for (const e of egresos) {
        const v = vol.get(e.categoria_code) ?? { n: 0, imp: 0 };
        v.n += 1;
        v.imp = Math.round((v.imp + Number(e.amount_out)) * 100) / 100;
        vol.set(e.categoria_code, v);
      }
      const out: ReglaVista[] = (filas as FilaRegla[]).map((f) => {
        const fm = (f.forma_medida ?? {}) as { candidata?: string; salvedad?: string; pareados?: number };
        const fr = esFirmable(f);
        const v = vol.get(f.categoria_code);
        return {
          categoria_code: f.categoria_code,
          tipo_regla: f.tipo_regla,
          estado: f.estado,
          tiene_fila: true,
          cuenta_gasto: f.cuenta_gasto,
          cuenta_nombre: f.cuenta_nombre,
          aprobada_por: f.aprobada_por,
          aprobada_en: f.aprobada_en,
          firmable: fr.firmable,
          motivo_no_firmable: fr.firmable ? null : fr.motivo,
          indicio: fm.candidata ?? null,
          evidencia: f.concepto_medido ?? null,
          salvedad: fm.salvedad ?? null,
          pareados: typeof fm.pareados === 'number' ? fm.pareados : null,
          movimientos_mes: v?.n ?? 0,
          importe_mes: v?.imp ?? 0,
        };
      });
      const conFila = new Set(out.map((r) => r.categoria_code));
      for (const [cat, v] of vol) {
        if (conFila.has(cat)) continue;
        out.push({
          categoria_code: cat, tipo_regla: 'sin_medir', estado: 'sin_regla', tiene_fila: false,
          cuenta_gasto: null, cuenta_nombre: null, aprobada_por: null, aprobada_en: null,
          firmable: false,
          motivo_no_firmable: 'la categoría no tiene fila en contpaqi.account_rules: el derivador nunca la midió',
          indicio: null, evidencia: null, salvedad: null, pareados: null,
          movimientos_mes: v.n, importe_mes: v.imp,
        });
      }
      return out.sort((a, b) => b.importe_mes - a.importe_mes || a.categoria_code.localeCompare(b.categoria_code));
    });
  }

  /** `[CP.8.53]` Las cuentas que una regla por categoría puede llevar: gasto `52*`, afectables, vivas. */
  async cuentasGasto(): Promise<{ codigo: string; nombre: string }[]> {
    return this.conTenant(async () => this.db('analytics.contpaqi_accounts')
      .where('codigo', 'like', `${PREFIJO_GASTO}%`)
      .where('afectable', 1)
      .where((q) => q.whereNull('es_baja').orWhere('es_baja', false))
      .orderBy('codigo')
      .select('codigo', 'nombre'));
  }

  /**
   * `[CP.8.53]` — **El contador firma la cuenta de una categoría.** Desde ese momento el armador
   * la usa: los egresos de esa categoría entran al archivo sin tocar código.
   *
   * ⛔ Valida contra el catálogo de ContPAQi (`validarFirma`): una cuenta con forma válida que no
   * existe, que es de mayor o que no es de gasto se importaría como basura o cuadraría mal.
   */
  async firmarRegla(categoria: string, cuenta: string, por: string): Promise<ReglaVista> {
    return this.conTenant(async () => {
      const regla = await this.db('contpaqi.account_rules')
        .where({ tenant_id: MEGA, categoria_code: categoria }).first();
      const catalogo = /^\d{10}$/.test(String(cuenta ?? '').trim())
        ? ((await this.db('analytics.contpaqi_accounts').where({ codigo: String(cuenta).trim() })
          .first('codigo', 'nombre', 'afectable', 'es_baja')) as CuentaCatalogo | undefined) ?? null
        : null;
      const v = validarFirma({ regla: regla ?? null, cuenta, catalogo, por });
      if (!v.ok) throw new FirmaRechazada(v.motivo);
      await this.db('contpaqi.account_rules')
        .where({ tenant_id: MEGA, categoria_code: categoria })
        .update({
          estado: 'aprobada',
          cuenta_gasto: catalogo!.codigo,
          cuenta_nombre: catalogo!.nombre,
          aprobada_por: por,
          aprobada_en: this.db.fn.now(),
          updated_at: this.db.fn.now(),
        });
      this.log.log(`regla firmada: ${categoria} → ${catalogo!.codigo} (${por})`);
      return this.reglaVista(categoria);
    });
  }

  /**
   * `[CP.8.53]` Revocar una firma: la categoría vuelve a `sin_regla` y deja de armarse.
   *
   * ⚠️ Conserva `cuenta_gasto` y `aprobada_por` como **la última firma** (el CHECK lo permite en
   * `sin_regla`), para que se lea qué se revocó. Quién revocó y cuándo **no queda**: no hay
   * columna, y una tabla de historia sería una fase aparte. Deuda con nombre en el tracker.
   */
  async revocarRegla(categoria: string, por: string): Promise<ReglaVista> {
    return this.conTenant(async () => {
      const regla = await this.db('contpaqi.account_rules')
        .where({ tenant_id: MEGA, categoria_code: categoria }).first();
      const v = validarRevocacion(regla ?? null, por);
      if (!v.ok) throw new FirmaRechazada(v.motivo);
      await this.db('contpaqi.account_rules')
        .where({ tenant_id: MEGA, categoria_code: categoria })
        .update({ estado: 'sin_regla', updated_at: this.db.fn.now() });
      this.log.log(`regla revocada: ${categoria} (antes ${regla.cuenta_gasto}) por ${por}`);
      return this.reglaVista(categoria);
    });
  }

  private async reglaVista(categoria: string): Promise<ReglaVista> {
    const mes = new Date().toISOString().slice(0, 7);
    const r = (await this.reglas(mes)).find((x) => x.categoria_code === categoria);
    if (!r) throw new FirmaRechazada(`«${categoria}» desapareció de account_rules`);
    return r;
  }

  /** Devuelve la regla con la cuenta del proveedor puesta, o igual con su motivo si no resolvió. */
  private conProveedor(
    base: ReglaCuenta,
    concepto: unknown,
    indices: Map<string, IndiceProveedores>,
  ): ReglaCuenta {
    if (base.tipo_regla !== 'por_proveedor') return base;
    const idx = base.cuenta_prefijo ? indices.get(base.cuenta_prefijo) : undefined;
    if (!idx) return base;
    const r = resolverProveedor(idx, concepto);
    return r.veredicto === 'resuelto' ? { ...base, cuenta_gasto: r.cuenta } : base;
  }

  private async leerReglas(): Promise<Map<string, ReglaCuenta>> {
    const filas = await this.db('contpaqi.account_rules').where({ tenant_id: MEGA })
      .select('categoria_code', 'cuenta_gasto', 'cuenta_iva', 'confianza_pct', 'estado',
        'tipo_regla', 'cuenta_prefijo');
    return new Map(filas.map((f: any) => [f.categoria_code, {
      categoria_code: f.categoria_code,
      cuenta_gasto: f.cuenta_gasto,
      cuenta_iva: f.cuenta_iva,
      confianza_pct: f.confianza_pct === null ? null : Number(f.confianza_pct),
      estado: f.estado,
      tipo_regla: f.tipo_regla ?? 'por_categoria',
      cuenta_prefijo: f.cuenta_prefijo ?? null,
    } as ReglaCuenta]));
  }

  /**
   * `[CP.8.21]` — **Simula el armado POR LOTE**, que es la unidad real: ContPAQi agrupa.
   *
   * Medido: 4,067 de 4,457 pólizas de egreso de 2026 (91.2 %) tienen **un solo renglón de
   * banco**. Una póliza por movimiento daría 4,727 donde la contadora hace ~500 — un archivo
   * que cuadra y que ella no reconoce como su trabajo.
   *
   * Devuelve un renglón por lote con lo que entraría y los motivos de lo que no. No escribe.
   */
  /**
   * `[CP.8.38]` — **El archivo del mes: una póliza por lote, concatenadas.**
   *
   * ⛔⛔ **Generar NO es entregar, y por eso esto NO escribe `contpaqi.poliza_exports`.**
   * `entregada` significa *«salió un archivo de acá»* y arranca el reloj del cuadre: a los 5 días
   * el motor empieza a preguntar por qué no aparece del otro lado. Marcarlo al **descargar**
   * pondría en ese estado a archivos que nadie importó nunca, y el cuadre pasaría a medir cuánta
   * gente apretó un botón en vez de cuánto llegó a ContPAQi.
   *
   * ⭐ Sale del **mismo armado** que la pantalla (`construirLotes`): si fueran dos caminos, el
   * archivo podría no decir lo que la bandeja muestra, y eso no se descubre hasta la balanza.
   *
   * ⚠️ Serializa con el **sink**, que es el único lugar donde el token entra al concepto del
   * encabezado. Duplicar esa regla acá sería tener dos reglas.
   */
  async generarArchivoMes(anioMes: string): Promise<{
    mes: string; contenido: string; polizas: number; movimientos: number; total: number;
    nombre: string; entregado: false; ya_entregadas: number; cambiados: string[];
  }> {
    return this.conTenant(() => this.generarArchivoMesEnAlcance(anioMes));
  }

  private async generarArchivoMesEnAlcance(anioMes: string): Promise<{
    mes: string; contenido: string; polizas: number; movimientos: number; total: number;
    nombre: string; entregado: false; ya_entregadas: number; cambiados: string[];
  }> {
    const a = await this.armarArchivo(anioMes);
    return {
      mes: a.mes, contenido: a.contenido, polizas: a.polizas, movimientos: a.movimientos,
      total: a.total, nombre: a.nombre, entregado: false,
      ya_entregadas: a.ya_entregadas, cambiados: a.cambiados,
    };
  }

  /**
   * `[CP.8.52]` — **Contabilidad dice que ya cargó el archivo del mes en ContPAQi.**
   *
   * ⛔⛔ Se registra sólo lo que se cargó: `archivoBase64` es el archivo que importó, y tiene que
   * ser **idéntico, byte a byte**, al que la Suite genera hoy para ese mes (`compararArchivo`).
   * Si no, `EntregaRechazada` — se pide regenerar, no se aproxima.
   *
   * ⭐ Idempotente: `ON CONFLICT DO NOTHING` por evento. Marcar dos veces no duplica y **no toca**
   * lo ya registrado: el cuadre usa `updated_at` como hora de entrega, y reescribirla reiniciaría su
   * plazo; una póliza ya `aplicada` tampoco puede volver a `entregada`. (El `registrar()` de abajo
   * hace `merge`, por eso éste no lo usa.)
   */
  async marcarEntregado(anioMes: string, archivoBase64: string, por: string): Promise<{
    mes: string; polizas: number; nuevas: number; ya_registradas: number; total: number;
    archivo_sha256: string;
  }> {
    return this.conTenant(async () => {
      if (!por) throw new EntregaRechazada('no se pudo identificar quién marca la entrega');
      const recibido = Buffer.from(String(archivoBase64 ?? ''), 'base64');
      if (!recibido.length) throw new EntregaRechazada('falta el archivo que se cargó en ContPAQi');

      const arm = await this.armarArchivo(anioMes);
      const generado = Buffer.from(arm.contenido, 'latin1');
      const cmp = compararArchivo(recibido, generado);
      if (!cmp.igual) throw new EntregaRechazada(cmp.motivo);

      const huella = huellaArchivo(generado);
      const filas = filasDeEntrega({ tenantId: MEGA, mes: anioMes, lotes: arm.lotes, por, huella });
      const insertadas = await this.db('contpaqi.poliza_exports')
        .insert(filas)
        .onConflict(['tenant_id', 'evento_tipo', 'evento_id'])
        .ignore()
        .returning('evento_id');
      this.log.log(`entrega ${anioMes}: ${insertadas.length} nuevas · `
        + `${filas.length - insertadas.length} ya registradas · ${por}`);
      return {
        mes: anioMes,
        polizas: filas.length,
        nuevas: insertadas.length,
        ya_registradas: filas.length - insertadas.length,
        total: arm.total,
        archivo_sha256: huella,
      };
    });
  }

  /**
   * El archivo del mes y los lotes que lo forman. ⭐ **Un solo camino** para descargar y para
   * marcar entregado: si fueran dos, lo registrado podría no ser lo que se cargó.
   */
  private async armarArchivo(anioMes: string): Promise<{
    mes: string; contenido: string; polizas: number; movimientos: number; total: number;
    nombre: string; entregado: false; lotes: LoteArchivo[]; ya_entregadas: number; cambiados: string[];
  }> {
    if (!this.sink) throw new Error('no hay sink de pólizas conectado');
    const { lotes, fuera_de_lote } = await this.construirLotes(anioMes);
    const conAsiento = lotes.filter((l) => l.asiento && l.resumen.incluidas > 0);
    if (!conAsiento.length) {
      throw new Error(
        `ningún lote de ${anioMes} produce asiento: no hay archivo que generar. `
        + `${fuera_de_lote.movimientos} movimientos quedan además fuera de todo lote.`,
      );
    }

    /**
     * ⛔⛔ `[CP.8.53]` **Lo ya entregado no se vuelve a mandar.** Firmar una regla cambia lo que
     * arma un mes que quizá ya se cargó en ContPAQi: si el archivo trajera otra vez esos lotes,
     * importarlo los DUPLICARÍA allá. El archivo lleva sólo los lotes sin entrega registrada; un
     * lote entregado cuyo total cambió después no se reenvía y se declara en `cambiados`.
     * (`rechazada` = el cuadre dijo que nunca apareció: ése sí puede volver a mandarse.)
     */
    // `[CP.8.72]` Lo entregado se reconoce por (tipo, clave): un pago a proveedor y un lote nunca comparten clave.
    const entregados = new Map<string, number>(
      ((await this.db('contpaqi.poliza_exports')
        .where({ tenant_id: MEGA, periodo: anioMes })
        .whereIn('evento_tipo', ['bank_lote', 'bank_pago_proveedor'])
        .whereIn('estado', ['armada', 'entregada', 'aplicada'])
        .select('evento_tipo', 'evento_id', 'total')) as { evento_tipo: string; evento_id: string; total: string | number }[])
        .map((r) => [`${r.evento_tipo}|${r.evento_id}`, Number(r.total)]),
    );
    const cambiados: string[] = [];
    const pendientes = conAsiento.filter((l) => {
      const llave = `${l.evento_tipo}|${l.clave}`;
      if (!entregados.has(llave)) return true;
      if (Math.round(entregados.get(llave)! * 100) !== Math.round(l.asiento!.total * 100)) cambiados.push(l.clave);
      return false;
    });
    if (!pendientes.length) {
      throw new Error(
        `todo lo armable de ${anioMes} ya se entregó (${entregados.size} pólizas registradas): no hay archivo nuevo que generar.`
        + (cambiados.length
          ? ` ⚠️ ${cambiados.length} lote(s) cambiaron después de entregarse y NO se reenvían: ${cambiados.join(', ')}.`
          : ''),
      );
    }

    const partes: string[] = [];
    const lotesArchivo: LoteArchivo[] = [];
    let movimientos = 0;
    let total = 0;
    for (const l of pendientes) {
      const clave = l.clave;
      const r = await this.sink.entregar({
        evento_tipo: l.evento_tipo, evento_id: clave,
        tipo_poliza: l.asiento!.tipo_poliza, fecha: l.asiento!.fecha, concepto: l.asiento!.concepto,
        movimientos: l.asiento!.movimientos, total: l.asiento!.total,
        token: tokenDe(l.evento_tipo, clave),
        // `[CP.8.72]` El pago a proveedor lleva el UUID de cada factura y nota (renglones `AD`).
        ...(l.uuids.length ? { uuids: l.uuids } : {}),
      });
      if (r.estado !== 'entregada' || !r.archivo) {
        // ⛔ Un lote que el sink rechaza TUMBA el archivo entero. Servir el resto sería entregar
        // una póliza incompleta que cuadra sola y a la que le falta un día de banco.
        throw new Error(`el lote ${clave} no se pudo serializar: ${r.motivo ?? 'sin motivo'}`);
      }
      partes.push(r.archivo.contenido);
      lotesArchivo.push({ clave, evento_tipo: l.evento_tipo, asiento: l.asiento!, movimientos: l.resumen.incluidas });
      movimientos += l.resumen.incluidas;
      total = Math.round((total + l.asiento!.total) * 100) / 100;
    }

    this.log.log(`archivo ${anioMes}: ${pendientes.length} pólizas · ${movimientos} movimientos `
      + `· ${total} · NO marcado como entregado · ${entregados.size} ya entregadas fuera`
      + (cambiados.length ? ` · ⚠️ ${cambiados.length} cambiaron tras entregarse` : ''));
    return {
      mes: anioMes,
      contenido: partes.join(''),
      polizas: pendientes.length,
      movimientos,
      total,
      nombre: `egresos-banco-${anioMes}.txt`,
      entregado: false,
      lotes: lotesArchivo,
      ya_entregadas: entregados.size,
      cambiados,
    };
  }

  async simularLotes(anioMes: string): Promise<ResumenMes> {
    return this.conTenant(async () => {
      const { lotes, fuera_de_lote } = await this.construirLotes(anioMes);
      return { lotes: lotes.map((l) => l.resumen), fuera_de_lote };
    });
  }

  /**
   * El armado de los lotes del mes, con su asiento. ⭐ Lo consumen la pantalla y el archivo:
   * **un solo camino**, para que lo que se ve y lo que se descarga no puedan diferir.
   */
  /**
   * `[CP.8.72]` La fuente del pago a proveedor, por mes y por 10 minutos: cargarla cuesta segundos (dos fases
   * de consultas sobre Kepler, CFDI y la historia de ContPAQi; ver `pago-proveedor.fuente.ts`) y la pantalla,
   * el archivo y «marcar entregado» la piden seguido. La huella invalida si los movimientos del mes cambian.
   * ⚠️ Deuda con nombre: medido 2.5–3 s por mes desde la laptop; en el clúster NO MEDIDO.
   */
  private readonly fuentes = new Map<string, { en: number; huella: string; fuente: FuentePagoProveedor }>();

  private async fuenteDelMes(anioMes: string, movs: MovimientoPago[]): Promise<FuentePagoProveedor> {
    const huella = movs.map((m) => `${m.cuenta_banco}|${m.fecha}|${m.importe}|${m.concepto}`).join(';');
    const c = this.fuentes.get(anioMes);
    if (c && c.huella === huella && Date.now() - c.en < 10 * 60_000) return c.fuente;
    const [y, m] = anioMes.split('-').map(Number);
    const hasta = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const t0 = Date.now();
    const fuente = await FuentePagoProveedor.cargar(this.db, movs, `${anioMes}-01`, hasta);
    this.log.log(`fuente de pago a proveedor ${anioMes}: ${movs.length} movimientos · ${Date.now() - t0} ms`);
    this.fuentes.set(anioMes, { en: Date.now(), huella, fuente });
    return fuente;
  }

  /**
   * `[CP.8.73]` Las confirmaciones vigentes de esos movimientos. ⛔ Lectura OPCIONAL en SAVEPOINT, con las dos
   * ausencias distinguidas (ADR-056, mismo molde que `supplier_aliases`): sin la migración, el armado sigue
   * sin confirmaciones; sin permiso, sigue igual pero lo grita.
   */
  private async leerConfirmaciones(ids: string[]): Promise<Map<string, FilaConfirmacion>> {
    if (!ids.length) return new Map();
    try {
      const filas = (await this.db.transaction((sp) => sp('contpaqi.pago_confirmaciones')
        .where({ tenant_id: MEGA, active: true }).whereIn('bank_movement_id', ids)
        .select('bank_movement_id', 'facturas', 'notas', 'pagado', 'confirmado_por'))) as FilaConfirmacion[];
      return new Map(filas.map((f) => [String(f.bank_movement_id), f]));
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === '42P01') this.log.warn('contpaqi.pago_confirmaciones no existe en este destino: se arma sin confirmaciones');
      else this.log.error(`⛔ contpaqi.pago_confirmaciones ilegible (${code ?? 'sin código'}): se arma SIN las confirmaciones. ${(e as Error)?.message ?? e}`);
      return new Map();
    }
  }

  /** `[CP.8.73]` Qué hace el armado con un pago a proveedor: la confirmación humana gana; si no, la fuente. */
  private resolverPago(fuente: FuentePagoProveedor, m: MovimientoPago, conf: FilaConfirmacion | undefined): ResolucionPago {
    if (!conf) return fuente.resolver(m);
    // ⛔ Si el movimiento cambió de importe después de confirmar, la confirmación no se aplica a ciegas.
    if (Math.round(Number(conf.pagado) * 100) !== Math.round(m.importe * 100)) {
      return { estado: 'a_confirmar', motivo: `la confirmación era por ${Number(conf.pagado).toFixed(2)} y el movimiento hoy es ${m.importe.toFixed(2)}` };
    }
    return fuente.entradaConfirmada(m, conf.facturas ?? [], conf.notas ?? []);
  }

  /**
   * `[CP.8.73]` Los pagos a proveedor del mes que NO se armaron solos, con la propuesta para confirmarlos:
   * el proveedor, sus facturas y notas abiertas y una sugerencia que la pantalla NO preselecciona.
   */
  async pagosPorConfirmar(anioMes: string): Promise<PagoPorConfirmar[]> {
    return this.conTenant(async () => {
      const egresos = (await this.leerEgresos(anioMes)).filter((e) => e.cuenta_banco);
      const reglas = await this.leerReglas();
      const pagos = egresos.filter((e) => reglas.get(e.categoria_code)?.tipo_regla === 'por_proveedor');
      if (!pagos.length) return [];
      const movs = pagos.map((e): MovimientoPago => ({ cuenta_banco: e.cuenta_banco, importe: Number(e.amount_out), fecha: e.fecha, concepto: String(e.concept ?? '') }));
      const fuente = await this.fuenteDelMes(anioMes, movs);
      const confs = await this.leerConfirmaciones(pagos.map((e) => String(e.id)));
      const out: PagoPorConfirmar[] = [];
      pagos.forEach((e, i) => {
        const conf = confs.get(String(e.id));
        const r = this.resolverPago(fuente, movs[i], conf);
        let motivo: string | null = null;
        if (r.estado === 'armable') {
          try { armarPagoProveedorCompleto({ ...r.entrada, concepto: 'X' }); if (!conf) return; }
          catch (err) { motivo = err instanceof AsientoRechazado ? err.message : String(err); }
        } else motivo = r.motivo;
        // Un pago confirmado que se arma bien también se lista: es donde se puede desconfirmar.
        out.push({
          movimiento_id: String(e.id), fecha: e.fecha, cuenta_banco: e.cuenta_banco,
          banco_label: [e.banco_nombre, e.banco_label].filter(Boolean).join(' ').trim() || null,
          importe: movs[i].importe, concepto: movs[i].concepto,
          motivo: motivo ?? 'confirmado: se arma con lo confirmado',
          propuesta: fuente.proponer(movs[i]),
          confirmacion: conf ? { facturas: conf.facturas, notas: conf.notas, confirmado_por: conf.confirmado_por, vigente: !motivo } : null,
        });
      });
      return out;
    });
  }

  /**
   * `[CP.8.73]` Una persona confirma qué facturas y notas paga un movimiento. ⛔ Se guarda SÓLO si el pago se
   * arma completo con eso (facturas − notas = pagado, del mismo proveedor, en la ventana): una confirmación que
   * no cuadra no se guarda para «arreglarla después». Reemplaza a la vigente (la apaga, no la borra).
   */
  async confirmarPago(movimientoId: string, facturas: string[], notas: string[], por: string): Promise<{ movimiento_id: string; renglones: number; total: number; redondeo: number }> {
    return this.conTenant(async () => {
      if (!por) throw new ConfirmacionRechazada('no se pudo identificar quién confirma');
      const m = await this.movimientoDePago(movimientoId);
      const anioMes = m.fecha.slice(0, 7);
      const fuente = await this.fuenteDelMes(anioMes, await this.movimientosPagoDelMes(anioMes));
      const r = fuente.entradaConfirmada(m, facturas ?? [], notas ?? []);
      if (r.estado !== 'armable') throw new ConfirmacionRechazada(r.motivo);
      const entrada = r.entrada;
      const a = ((): ReturnType<typeof armarPagoProveedorCompleto> => {
        try { return armarPagoProveedorCompleto({ ...entrada, concepto: 'CONFIRMACION' }); }
        catch (err) { throw new ConfirmacionRechazada(err instanceof Error ? err.message : String(err)); }
      })();
      await this.db('contpaqi.pago_confirmaciones').where({ tenant_id: MEGA, bank_movement_id: movimientoId, active: true })
        .update({ active: false, updated_at: this.db.fn.now(), updated_by: por });
      await this.db('contpaqi.pago_confirmaciones').insert({
        tenant_id: MEGA, bank_movement_id: movimientoId,
        facturas: r.entrada.facturas.map((f) => f.uuid), notas: r.entrada.notas.map((n) => n.uuid),
        pagado: m.importe, confirmado_por: por, created_by: por, updated_by: por,
      });
      this.fuentes.delete(anioMes);
      this.log.log(`pago ${movimientoId} confirmado por ${por}: ${r.entrada.facturas.length} facturas · ${r.entrada.notas.length} notas`);
      return { movimiento_id: movimientoId, renglones: a.movimientos.length, total: a.total, redondeo: a.redondeo };
    });
  }

  /** `[CP.8.73]` Apaga la confirmación vigente: el pago vuelve a resolverse solo (o a «a confirmar»). */
  async desconfirmarPago(movimientoId: string, por: string): Promise<{ movimiento_id: string; apagadas: number }> {
    return this.conTenant(async () => {
      if (!por) throw new ConfirmacionRechazada('no se pudo identificar quién desconfirma');
      const n = await this.db('contpaqi.pago_confirmaciones').where({ tenant_id: MEGA, bank_movement_id: movimientoId, active: true })
        .update({ active: false, updated_at: this.db.fn.now(), updated_by: por });
      if (!n) throw new ConfirmacionRechazada('ese movimiento no tiene una confirmación vigente');
      this.fuentes.clear();
      return { movimiento_id: movimientoId, apagadas: Number(n) };
    });
  }

  /** El egreso como lo ve el armado, validando que sea un pago a proveedor con banco. */
  private async movimientoDePago(movimientoId: string): Promise<MovimientoPago> {
    const e = (await this.db('finance.bank_movements as m')
      .join('finance.movement_categories as c', 'c.id', 'm.category_id')
      .leftJoin('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
      .where('m.tenant_id', MEGA).where('m.id', movimientoId).whereNull('m.deleted_at')
      .first('m.concept', 'm.amount_out', 'c.code as categoria_code', 'ba.contpaqi_cuenta as cuenta_banco',
        this.db.raw(`to_char(m.movement_date, 'YYYY-MM-DD') as fecha`))) as
      { concept: string | null; amount_out: string | number; categoria_code: string; cuenta_banco: string | null; fecha: string } | undefined;
    if (!e) throw new ConfirmacionRechazada('el movimiento no existe');
    if (!e.cuenta_banco) throw new ConfirmacionRechazada('el movimiento no es de una cuenta de banco con cuenta en ContPAQi');
    const regla = (await this.leerReglas()).get(e.categoria_code);
    if (regla?.tipo_regla !== 'por_proveedor') throw new ConfirmacionRechazada(`el movimiento es de «${e.categoria_code}», no un pago a proveedor`);
    if (!(Number(e.amount_out) > 0)) throw new ConfirmacionRechazada('el movimiento no es un egreso');
    return { cuenta_banco: e.cuenta_banco, importe: Number(e.amount_out), fecha: e.fecha, concepto: String(e.concept ?? '') };
  }

  /** Los pagos a proveedor del mes, como entran a la fuente (misma huella que `construirLotes`). */
  private async movimientosPagoDelMes(anioMes: string): Promise<MovimientoPago[]> {
    const reglas = await this.leerReglas();
    return (await this.leerEgresos(anioMes))
      .filter((e) => e.cuenta_banco && reglas.get(e.categoria_code)?.tipo_regla === 'por_proveedor')
      .map((e): MovimientoPago => ({ cuenta_banco: e.cuenta_banco, importe: Number(e.amount_out), fecha: e.fecha, concepto: String(e.concept ?? '') }));
  }

  private async construirLotes(anioMes: string): Promise<{
    lotes: PolizaArmada[];
    fuera_de_lote: ResumenMes['fuera_de_lote'];
  }> {
    const egresos = await this.leerEgresos(anioMes);
    const reglas = await this.leerReglas();
    const indices = await this.leerIndicesProveedor(reglas);

    // (cuenta de banco × día) — exactamente el grano de la póliza real.
    const grupos = new Map<string, any[]>();
    const sinBanco: any[] = [];
    for (const e of egresos) {
      if (!e.cuenta_banco) { sinBanco.push(e); continue; }
      const k = `${e.cuenta_banco}|${e.fecha}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push(e);
    }

    // ⭐ `[CP.8.72]` El pago a proveedor NO va al lote del día: la contadora hace UNA póliza por pago (un solo
    // renglón de banco) y la forma «2120 / banco» del lote es la real en 1.7 % de los casos (`[CP.8.60]`).
    // Se resuelve con la fuente (qué facturas y notas paga) y se arma completo; lo que no, se cuenta en el
    // lote con su motivo — nunca se asienta incompleto.
    const esPagoProveedor = (e: { categoria_code: string }): boolean => reglas.get(e.categoria_code)?.tipo_regla === 'por_proveedor';
    const aMovimiento = (e: { cuenta_banco: string; amount_out: string | number; fecha: string; concept: unknown }): MovimientoPago => ({
      cuenta_banco: e.cuenta_banco, importe: Number(e.amount_out), fecha: e.fecha, concepto: String(e.concept ?? ''),
    });
    const movsPago = egresos.filter((e) => e.cuenta_banco && esPagoProveedor(e)).map(aMovimiento);
    const fuente = movsPago.length ? await this.fuenteDelMes(anioMes, movsPago) : null;
    // `[CP.8.73]` La confirmación humana gana sobre lo que la fuente resuelve sola.
    const confs = movsPago.length
      ? await this.leerConfirmaciones(egresos.filter((e) => e.cuenta_banco && esPagoProveedor(e)).map((e) => String(e.id)))
      : new Map<string, FilaConfirmacion>();

    const out: PolizaArmada[] = [];
    for (const [k, todas] of [...grupos.entries()].sort()) {
      const [cuenta_banco, fecha] = k.split('|');
      const banco_label = [todas[0]?.banco_nombre, todas[0]?.banco_label].filter(Boolean).join(' ').trim() || null;
      const filas = todas.filter((e) => !esPagoProveedor(e));
      const motivosPago: Record<string, number> = {};
      for (const e of todas.filter(esPagoProveedor)) {
        let motivo: string;
        // `fuente` existe siempre que haya pagos a proveedor: se cargó con todos ellos arriba.
        const r = fuente ? this.resolverPago(fuente, aMovimiento(e), confs.get(String(e.id))) : { estado: 'sin_resolver' as const, motivo: 'sin fuente' };
        if (r.estado === 'armable') {
          try {
            const concepto = `PAGO ${String(e.concept ?? '').trim() || 'A PROVEEDOR'}`;
            const a = armarPagoProveedorCompleto({ ...r.entrada, concepto });
            out.push({
              evento_tipo: 'bank_pago_proveedor', clave: String(e.id), asiento: a, uuids: a.uuids,
              resumen: {
                cuenta_banco, banco_label, fecha, movimientos: 1, incluidas: 1, renglones: a.movimientos.length,
                total: a.total, iva_traspaso: null, motivos: {}, tipo: 'pago_proveedor', fuente: r.fuente, cfdis: a.uuids.length,
                clave: `pago|${e.id}`,
              },
            });
            continue;
          } catch (err) {
            motivo = err instanceof AsientoRechazado ? `pago_${err.motivo}` : 'pago_error';
          }
        } else {
          motivo = r.estado === 'a_confirmar' ? 'pago_a_confirmar' : 'pago_sin_resolver';
        }
        motivosPago[motivo] = (motivosPago[motivo] ?? 0) + 1;
      }
      const entradas = filas.map((e) => {
        const subtotal = Number(e.amount_out);
        const iva = Number(e.iva_hermano ?? 0);
        // Una categoría sin fila en `account_rules` no se inventa: entra con `sin_medir`
        // para que el lote la rechace con ese motivo, no con uno prestado.
        const base = reglas.get(e.categoria_code) ?? {
          categoria_code: e.categoria_code, cuenta_gasto: null, cuenta_iva: '1060000000',
          confianza_pct: null, estado: 'sin_regla' as const, tipo_regla: 'sin_medir' as const,
          cuenta_prefijo: null,
        };
        return {
          // ⭐ `[CP.8.35]` En una regla `por_proveedor` la cuenta **no es de la categoría**: hay
          // que resolverla por movimiento, desde el concepto del banco. Sin este paso los 216
          // movimientos de `compra_mercancia` de enero ($43.5M) se rechazaban en bloque.
          // ⛔ Si no resuelve, se deja `cuenta_gasto` en null **con su motivo**: el armador la
          // rechaza con `proveedor_sin_cuenta` y la bandeja dice por qué, en vez de inventar.
          regla: this.conProveedor(base, e.concept, indices),
          subtotal,
          iva,
          total: Math.round((subtotal + iva) * 100) / 100,
          cuenta_banco,
          concepto: String(e.concept ?? '').trim() || e.categoria_nombre,
          fecha,
          seg_negocio: 0,
        };
      });

      const lote = armarLoteEgresos(cuenta_banco, fecha, entradas,
        `EGRESOS ${fecha} ${cuenta_banco}`);
      const porMotivo: Record<string, number> = { ...motivosPago };
      for (const r of lote.rechazadas) porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;
      const armadosAparte = todas.length - filas.length - Object.values(motivosPago).reduce((a, n) => a + n, 0);
      if (todas.length === armadosAparte) continue;   // el día sólo tenía pagos a proveedor, todos armados aparte

      out.push({ evento_tipo: 'bank_lote', clave: k, asiento: lote.asiento, uuids: [], resumen: {
        cuenta_banco,
        banco_label,
        fecha,
        // ⚠️ Los pagos armados aparte son su propia póliza: no se cuentan dos veces en el lote.
        movimientos: todas.length - armadosAparte,
        incluidas: lote.incluidas,
        renglones: lote.asiento?.movimientos.length ?? 0,
        total: lote.asiento?.total ?? 0,
        iva_traspaso: lote.asiento?.iva_traspaso ?? null,
        motivos: porMotivo,
        tipo: 'lote',
        clave: k,
      } });
    }
    // ⭐ `[CP.8.34]` Lo que quedó fuera se AGRUPA y se devuelve, no se registra en un `warn`.
    // Un hueco que sólo existe en el log no lo ve quien mira la pantalla, que es justo
    // quien necesita saber que el denominador no es el universo del mes.
    const porCuenta = new Map<string, CuentaFueraDeLote>();
    for (const e of sinBanco) {
      const cuenta = [e.banco_nombre, e.banco_label].filter(Boolean).join(' ').trim() || '(sin cuenta)';
      const acc = porCuenta.get(cuenta) ?? { cuenta, movimientos: 0, importe: 0 };
      acc.movimientos += 1;
      acc.importe = Math.round((acc.importe + Number(e.amount_out)) * 100) / 100;
      porCuenta.set(cuenta, acc);
    }
    const cuentas = [...porCuenta.values()].sort((a, b) => b.movimientos - a.movimientos);
    const fuera = {
      movimientos: sinBanco.length,
      importe: Math.round(cuentas.reduce((a, c) => a + c.importe, 0) * 100) / 100,
      cuentas,
    };

    const conAsiento = out.filter((l) => l.resumen.incluidas > 0).length;
    const pagos = out.filter((l) => l.evento_tipo === 'bank_pago_proveedor').length;
    this.log.log(`lotes ${anioMes}: ${out.length - pagos} (banco × día) + ${pagos} pagos a proveedor completos de ${movsPago.length}`
      + ` · ${conAsiento} con asiento · ${fuera.movimientos} fuera de lote (${cuentas.map((c) => c.cuenta).join(', ') || '—'})`);
    return { lotes: out, fuera_de_lote: fuera };
  }

  /**
   * Deja el registro. ⭐ `onConflict` por `(evento_tipo, evento_id)`: **reenviar el mismo evento
   * no duplica** — es el riesgo que `[LC.2]` midió costando $32.6M contabilizados dos veces.
   *
   * ⛔ Nace en `entregada`, nunca en `aplicada`. Quién puede decir que ContPAQi la tiene es el
   * cuadre, leyendo el carril de vuelta.
   */
  private async registrar(
    eventoId: string, periodo: string, asiento: any, token: string,
    estado: string, motivo: string,
  ): Promise<void> {
    await this.db('contpaqi.poliza_exports')
      .insert({
        tenant_id: MEGA,
        evento_tipo: 'bank_movement',
        evento_id: eventoId,
        periodo,
        asiento: JSON.stringify({ ...asiento, token }),
        total: asiento.total,
        estado: estado === 'entregada' ? 'entregada' : 'rechazada',
        sink: this.sink?.sink ?? null,
        motivo,
        updated_at: this.db.fn.now(),
      })
      .onConflict(['tenant_id', 'evento_tipo', 'evento_id'])
      .merge(['asiento', 'total', 'estado', 'sink', 'motivo', 'updated_at']);
  }
}
