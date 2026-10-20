import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import {
  CONTPAQI_POLIZA_SINK_PORT, type ContpaqiPolizaSinkPort,
} from '@megadulces/contracts';
import { AlcanceTenant } from './alcance-tenant';
import { compararArchivo, filasDeEntrega, huellaArchivo, type LoteArchivo } from './entrega';

/**
 * `[CP.8.52]` La entrega se niega con un motivo que quien marca tiene que leer (archivo distinto,
 * sin autor). El controlador la traduce a 409/400; cualquier otro error es nuestro.
 */
export class EntregaRechazada extends Error {
  readonly code = 'entrega_rechazada';
}
import {
  armarAsientoEgreso, armarLoteEgresos, AsientoRechazado, type ReglaCuenta,
} from './poliza-egreso';
import { tokenDe } from './token';
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
   */
  private async leerEgresos(anioMes: string): Promise<any[]> {
    return this.db
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
        LEFT JOIN LATERAL (
          SELECT h.amount_out
            FROM finance.bank_movements h
            JOIN finance.movement_categories hc ON hc.id = h.category_id
           WHERE h.tenant_id = m.tenant_id AND h.deleted_at IS NULL
             AND hc.code = 'iva_acreditable'
             AND h.bank_account_id = m.bank_account_id
             AND h.movement_date   = m.movement_date
             AND round(m.amount_out * 0.16, 2) = round(h.amount_out, 2)
           ORDER BY h.id LIMIT 1
        ) iva ON true`)
      .where('m.tenant_id', MEGA)
      .whereNull('m.deleted_at')
      .where('m.amount_out', '>', 0)
      // El IVA no se arma solo: es el renglón 2 del asiento de su hermano.
      .whereNot('c.code', 'iva_acreditable')
      .whereRaw(`to_char(m.movement_date, 'YYYY-MM') = ?`, [anioMes])
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
    nombre: string; entregado: false;
  }> {
    return this.conTenant(() => this.generarArchivoMesEnAlcance(anioMes));
  }

  private async generarArchivoMesEnAlcance(anioMes: string): Promise<{
    mes: string; contenido: string; polizas: number; movimientos: number; total: number;
    nombre: string; entregado: false;
  }> {
    const a = await this.armarArchivo(anioMes);
    return {
      mes: a.mes, contenido: a.contenido, polizas: a.polizas, movimientos: a.movimientos,
      total: a.total, nombre: a.nombre, entregado: false,
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
    nombre: string; entregado: false; lotes: LoteArchivo[];
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

    const partes: string[] = [];
    const lotesArchivo: LoteArchivo[] = [];
    let movimientos = 0;
    let total = 0;
    for (const l of conAsiento) {
      const clave = `${l.resumen.cuenta_banco}|${l.resumen.fecha}`;
      const r = await this.sink.entregar({
        evento_tipo: 'bank_lote', evento_id: clave,
        tipo_poliza: l.asiento!.tipo_poliza, fecha: l.asiento!.fecha, concepto: l.asiento!.concepto,
        movimientos: l.asiento!.movimientos, total: l.asiento!.total,
        token: tokenDe('bank_lote', clave),
      });
      if (r.estado !== 'entregada' || !r.archivo) {
        // ⛔ Un lote que el sink rechaza TUMBA el archivo entero. Servir el resto sería entregar
        // una póliza incompleta que cuadra sola y a la que le falta un día de banco.
        throw new Error(`el lote ${clave} no se pudo serializar: ${r.motivo ?? 'sin motivo'}`);
      }
      partes.push(r.archivo.contenido);
      lotesArchivo.push({ clave, asiento: l.asiento!, movimientos: l.resumen.incluidas });
      movimientos += l.resumen.incluidas;
      total = Math.round((total + l.asiento!.total) * 100) / 100;
    }

    this.log.log(`archivo ${anioMes}: ${conAsiento.length} pólizas · ${movimientos} movimientos `
      + `· ${total} · NO marcado como entregado`);
    return {
      mes: anioMes,
      contenido: partes.join(''),
      polizas: conAsiento.length,
      movimientos,
      total,
      nombre: `egresos-banco-${anioMes}.txt`,
      entregado: false,
      lotes: lotesArchivo,
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
  private async construirLotes(anioMes: string): Promise<{
    lotes: { resumen: ResumenLote; asiento: ReturnType<typeof armarLoteEgresos>['asiento'] }[];
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

    const out: { resumen: ResumenLote; asiento: ReturnType<typeof armarLoteEgresos>["asiento"] }[] = [];
    for (const [k, filas] of [...grupos.entries()].sort()) {
      const [cuenta_banco, fecha] = k.split('|');
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
      const porMotivo: Record<string, number> = {};
      for (const r of lote.rechazadas) porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;

      out.push({ asiento: lote.asiento, resumen: {
        cuenta_banco,
        banco_label: [filas[0]?.banco_nombre, filas[0]?.banco_label].filter(Boolean).join(' ').trim() || null,
        fecha,
        movimientos: filas.length,
        incluidas: lote.incluidas,
        renglones: lote.asiento?.movimientos.length ?? 0,
        total: lote.asiento?.total ?? 0,
        iva_traspaso: lote.asiento?.iva_traspaso ?? null,
        motivos: porMotivo,
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
    this.log.log(`lotes ${anioMes}: ${out.length} (banco × día) · ${conAsiento} con asiento`
      + ` · ${fuera.movimientos} fuera de lote (${cuentas.map((c) => c.cuenta).join(', ') || '—'})`);
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
