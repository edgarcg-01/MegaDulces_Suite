import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { AlcanceTenant } from './alcance-tenant';
import { reglaBeneficiario, type ReglaBeneficiario } from './beneficiario';

/**
 * `[CP.8.80]` — **Categorizar un egreso desde el puente, y que se recuerde por beneficiario.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Un egreso sin categoría no entra al archivo de ContPAQi (`[CP.8.79]`), y **no había dónde ponérsela**:
 * Bancos es de sólo lectura desde `[CB.14]` y el `PATCH /finance/bank/movements/:id/category` no lo llamaba
 * ninguna pantalla. El puente mandaba a «Categorizar en Bancos» y Bancos abría en otra pestaña, sin filtro y
 * sin forma de categorizar. Medido el 2026-10-22: **5,500 movimientos sin categoría** y ~960 egresos de banco
 * a beneficiarios con nombre propio ($21 M) que ninguna palabra clave alcanza.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · Pone la categoría al movimiento (`classified_by = 'manual'`: ninguna regla la vuelve a tocar).
 *  · Si la persona lo pide, escribe una regla del MISMO motor de bancos (`finance.bank_classify_rules`) para
 *    los que empiezan con ese nombre, y la aplica a los que hoy están sin categoría. El próximo estado de
 *    cuenta la usa al importar: no hay motor nuevo ni tabla nueva.
 *
 * ⛔ Lo que NO hace, a propósito:
 *  · **No cambia una categoría que ya existe.** Eso es decisión de Finanzas, y desde acá no se ve por qué la
 *    tiene. Sólo llena lo vacío.
 *  · **No toca lo categorizado a mano**, ni siquiera vacío (`classified_by = 'manual'` sin categoría: 29 hoy).
 *  · **No pisa una regla de otra categoría** con el mismo texto: si existe, se rechaza y se dice cuál.
 *
 * ⭐ Las reglas nuevas van AL FINAL (prioridad ≥ 1000, después de `[CB.54]`): sólo alcanzan lo que ninguna otra
 * regla toma. Lo que hoy está sin categoría ya pasó por todas las anteriores, así que aplicarla ahora da lo mismo
 * que reclasificar con el catálogo completo.
 *
 * Permiso propio: `FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR` (decisión del PM, 2026-10-22). Gestionar Bancos daría
 * además subir estados de cuenta y editar cuentas, que no es trabajo de Contabilidad.
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
/** Las reglas por beneficiario arrancan acá: después de todo el catálogo (`[CB.54]` llega a 903). */
const PRIORIDAD_BENEFICIARIO = 1000;
/** Cuántas filas viajan en la vista previa. El total SIEMPRE se cuenta entero y se dice. */
const MUESTRA = 50;

export class CategorizacionRechazada extends Error {
  readonly code = 'categorizacion_rechazada';
}

export interface CategoriaEgreso {
  code: string;
  nombre: string;
  grupo: string;
}

export interface CoincidenciaBeneficiario {
  id: string;
  fecha: string;
  banco: string;
  concepto: string;
  importe: number;
}

export interface VistaPreviaBeneficiario {
  texto: string;
  /** Egresos hoy sin categoría que la regla tomaría, contando el que se está categorizando. */
  movimientos: number;
  importe: number;
  /** Los primeros `MUESTRA`, más recientes primero. ⛔ `movimientos` puede ser mayor: se dice en pantalla. */
  filas: CoincidenciaBeneficiario[];
  /** Si ya hay una regla con ese mismo texto. */
  regla_existente: { prioridad: number; categoria: string } | null;
}

export interface ResultadoCategorizar {
  movimiento_id: string;
  categoria: string;
  regla: { prioridad: number; texto: string; nueva: boolean } | null;
  /** Otros egresos sin categoría que tomó la regla (sin contar el categorizado). */
  aplicados: number;
  importe_aplicado: number;
}

interface FilaMovimiento {
  id: string;
  fecha: string;
  banco: string | null;
  raw_type: string | null;
  raw_code: string | null;
  concept: string | null;
  amount_out: string | number;
  category_id: string | null;
  classified_by: string | null;
}

@Injectable()
export class ContpaqiCategoriaService {
  private readonly log = new Logger(ContpaqiCategoriaService.name);
  /** RLS forzado y `app_runtime` sin tenant: ver `alcance-tenant.ts` (`[CP.8.58]`). */
  private readonly alcance = new AlcanceTenant();

  constructor(@Inject('KNEX_NEW_DB') private readonly pool: Knex) {}

  private get db(): Knex {
    return this.alcance.db;
  }

  private conTenant<T>(fn: () => Promise<T>): Promise<T> {
    return this.alcance.run(this.pool, MEGA, fn);
  }

  /** Las categorías que puede llevar un egreso (`flow` out o both), por grupo. */
  async categorias(): Promise<CategoriaEgreso[]> {
    return this.conTenant(async () => {
      const filas = await this.db('finance.movement_categories')
        .where({ tenant_id: MEGA, active: true }).whereIn('flow', ['out', 'both'])
        .orderBy([{ column: 'group_key' }, { column: 'sort_order' }, { column: 'name' }])
        .select('code', 'name', 'group_key');
      return (filas as { code: string; name: string; group_key: string }[])
        .map((f) => ({ code: f.code, nombre: f.name, grupo: f.group_key }));
    });
  }

  /** Lo que tomaría la regla «empieza con `texto`», sin escribir nada. */
  async vistaPrevia(movimientoId: string, texto: string): Promise<VistaPreviaBeneficiario> {
    return this.conTenant(async () => {
      const m = await this.movimiento(movimientoId);
      const r = this.regla(m, texto);
      const todas = await this.coincidencias(r);
      const existente = await this.reglaIgual(r);
      return {
        texto: r.texto,
        movimientos: todas.length,
        importe: redondear(todas.reduce((a, f) => a + Number(f.amount_out), 0)),
        filas: todas.slice(0, MUESTRA).map((f) => ({
          id: f.id, fecha: f.fecha, banco: f.banco ?? '', concepto: f.concept ?? f.raw_code ?? '', importe: Number(f.amount_out),
        })),
        regla_existente: existente ? { prioridad: existente.priority, categoria: existente.category_code } : null,
      };
    });
  }

  /**
   * Pone `categoria` al egreso y, con `beneficiario`, deja la regla y la aplica a los que hoy no tienen.
   * Todo en una transacción: si la regla se rechaza, el movimiento tampoco queda categorizado.
   */
  async categorizar(movimientoId: string, entrada: { categoria: string; beneficiario?: string }, por: string): Promise<ResultadoCategorizar> {
    return this.conTenant(async () => {
      if (!por) throw new CategorizacionRechazada('no se pudo identificar quién categoriza');
      const cat = await this.db('finance.movement_categories')
        .where({ tenant_id: MEGA, code: entrada.categoria, active: true }).whereIn('flow', ['out', 'both'])
        .first('id', 'code', 'name') as { id: string; code: string; name: string } | undefined;
      if (!cat) throw new CategorizacionRechazada(`«${entrada.categoria}» no es una categoría de egreso`);
      const m = await this.movimiento(movimientoId);
      if (m.category_id) throw new CategorizacionRechazada('el movimiento ya tiene categoría: se cambia en Finanzas, no desde aquí');

      let regla: ResultadoCategorizar['regla'] = null;
      let aplicados = 0;
      let importeAplicado = 0;
      if (entrada.beneficiario !== undefined) {
        const r = this.regla(m, entrada.beneficiario);
        // Dos personas guardando a la vez no pueden tomar la misma prioridad (`uq_fin_classrule`).
        await this.db.raw(`SELECT pg_advisory_xact_lock(hashtext('finance.bank_classify_rules'))`);
        const existente = await this.reglaIgual(r);
        if (existente && existente.category_code !== cat.code) {
          throw new CategorizacionRechazada(
            `ya hay una regla para «${r.texto}» que manda a «${existente.category_code}» (prioridad ${existente.priority})`);
        }
        let prioridad = existente?.priority ?? 0;
        if (!existente) {
          const max = await this.db('finance.bank_classify_rules').where({ tenant_id: MEGA }).max('priority as m').first() as { m: number | null } | undefined;
          prioridad = Math.max(Number(max?.m ?? 0), PRIORIDAD_BENEFICIARIO - 1) + 1;
          await this.db('finance.bank_classify_rules').insert({
            tenant_id: MEGA, priority: prioridad, match_type: r.match_type, match_code: r.match_code,
            match_concept: r.match_concept, category_code: cat.code, active: true,
            note: `Beneficiario «${r.texto}» (CP.8.80) por ${por}`,
          });
        }
        const otros = (await this.coincidencias(r)).filter((f) => f.id !== m.id);
        if (otros.length) {
          aplicados = Number(await this.db('finance.bank_movements')
            .where({ tenant_id: MEGA }).whereIn('id', otros.map((f) => f.id))
            .whereNull('category_id').whereNull('deleted_at').whereNot('classified_by', 'manual')
            .update({ category_id: cat.id, classified_by: 'rule', updated_at: this.db.fn.now() }));
          importeAplicado = redondear(otros.reduce((a, f) => a + Number(f.amount_out), 0));
        }
        regla = { prioridad, texto: r.texto, nueva: !existente };
      }

      const n = await this.db('finance.bank_movements')
        .where({ tenant_id: MEGA, id: m.id }).whereNull('category_id').whereNull('deleted_at')
        .update({ category_id: cat.id, classified_by: 'manual', updated_at: this.db.fn.now() });
      if (!n) throw new CategorizacionRechazada('el movimiento cambió mientras lo categorizabas: vuelve a abrirlo');
      this.log.log(`egreso ${m.id} → ${cat.code} por ${por}`
        + (regla ? ` · regla p${regla.prioridad} «${regla.texto}»${regla.nueva ? ' (nueva)' : ''} aplicada a ${aplicados} más` : ''));
      return { movimiento_id: m.id, categoria: cat.code, regla, aplicados, importe_aplicado: importeAplicado };
    });
  }

  /** El egreso, o el rechazo con su motivo. */
  private async movimiento(id: string): Promise<FilaMovimiento> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CategorizacionRechazada('movimiento inválido');
    const m = await this.base().where('m.id', id).first() as FilaMovimiento | undefined;
    if (!m) throw new CategorizacionRechazada('no existe ese movimiento');
    if (!(Number(m.amount_out) > 0)) throw new CategorizacionRechazada('no es un egreso: el puente sólo categoriza lo que sale');
    return m;
  }

  private regla(m: FilaMovimiento, texto: string): ReglaBeneficiario {
    const r = reglaBeneficiario(m, texto);
    if ('error' in r) throw new CategorizacionRechazada(r.error);
    return r;
  }

  /**
   * Los egresos que hoy no tienen categoría ni la decidió una persona, y que la regla tomaría. Se evalúa con la
   * misma regex que usará el motor de bancos (`normKey` + flag `i`).
   */
  private async coincidencias(r: ReglaBeneficiario): Promise<FilaMovimiento[]> {
    const filas = await this.base()
      .whereNull('m.category_id').whereNot('m.classified_by', 'manual').where('m.amount_out', '>', 0)
      .orderBy([{ column: 'm.movement_date', order: 'desc' }, { column: 'm.id' }]) as FilaMovimiento[];
    const re = (p: string | null): RegExp | null => (p ? new RegExp(p, 'i') : null);
    const [rt, rc, rx] = [re(r.match_type), re(r.match_code), re(r.match_concept)];
    const k = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
    return filas.filter((f) => (!rt || rt.test(k(f.raw_type))) && (!rc || rc.test(k(f.raw_code))) && (!rx || rx.test(k(f.concept))));
  }

  private async reglaIgual(r: ReglaBeneficiario): Promise<{ priority: number; category_code: string } | undefined> {
    return await this.db('finance.bank_classify_rules')
      .where({ tenant_id: MEGA, active: true })
      .whereRaw('match_type IS NOT DISTINCT FROM ?', [r.match_type])
      .whereRaw('match_code IS NOT DISTINCT FROM ?', [r.match_code])
      .whereRaw('match_concept IS NOT DISTINCT FROM ?', [r.match_concept])
      .orderBy('priority').first('priority', 'category_code') as { priority: number; category_code: string } | undefined;
  }

  private base(): Knex.QueryBuilder {
    return this.db('finance.bank_movements as m')
      .leftJoin('finance.bank_accounts as ba', 'ba.id', 'm.bank_account_id')
      .where('m.tenant_id', MEGA).whereNull('m.deleted_at')
      .select('m.id', 'm.raw_type', 'm.raw_code', 'm.concept', 'm.amount_out', 'm.category_id', 'm.classified_by',
        this.db.raw(`concat_ws(' ', ba.bank, ba.account_label) as banco`),
        this.db.raw(`to_char(m.movement_date, 'YYYY-MM-DD') as fecha`));
  }
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}
