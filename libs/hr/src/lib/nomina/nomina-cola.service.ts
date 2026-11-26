import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  HrCandidatoDeLaSuiteDto, HrCasoDeLaColaDto, HrColaNominaDto, HrResolucionDto, HrResuelveCasoDto,
} from '@megadulces/contracts';
import { HrNominaPuenteService } from './nomina-puente.service';

/**
 * Fase RH · frente NE · `[NE.2.5]` — LA COLA DE LOS QUE NO LIGARON, Y CÓMO SE RESUELVEN A MANO.
 *
 * El puente (`[NE.2.3]`) liga por nombre y **declara** lo que no puede ligar. Esto es lo que vuelve
 * reemplazable esa provisionalidad: una persona mira el caso, decide, **y firma**.
 *
 * ── Por qué acá sí viajan nombres ──────────────────────────────────────────────────────────────
 * El resto del frente devuelve códigos e identificadores a propósito. Esta superficie no puede:
 * **una identidad no se resuelve a ciegas**. Quien decide si el código 1234 de nómina es tal
 * persona necesita leer los dos nombres. Por eso todo va detrás de `HR_NOMINA_GESTIONAR`, que
 * sigue **sin repartir** hasta que exista la pantalla: un alias equivocado liga a una persona con
 * el sueldo de otra.
 *
 * ── Lo que NO hace, y es deliberado ────────────────────────────────────────────────────────────
 *  · ⛔ **No inventa candidatos.** Los que muestra son **exactamente** los que `tiendePuente` miró
 *    y descartó (`RechazoDePadron.candidatos`). Un segundo emparejador «parecido» daría una lista
 *    distinta de la que explica el rechazo, y el que firma estaría decidiendo sobre otra cosa
 *    (ADR-056).
 *  · ⛔ **No deja descartar un caso.** Marcar «este no liga y está bien» sería un dato nuestro, y
 *    hoy no hay dónde guardarlo. Mientras tanto los casos reaparecen, que es lo correcto: los
 *    `sin-candidato` se arreglan **dando de alta a la persona**, no callándolos. → D10.
 *  · ⛔ **No borra nada.** Corregir un alias equivocado lo **desactiva** y escribe uno nuevo: el
 *    único índice es parcial sobre `is_active`, así que la historia de a quién se le pagó antes
 *    sobrevive a la corrección.
 */
@Injectable()
export class HrNominaColaService {
  private readonly logger = new Logger(HrNominaColaService.name);

  /**
   * Lo mínimo que puede decir una firma. No es un número mágico: es que **«ok» o «.» no explican
   * nada**, y el valor de la nota es poder contestar dentro de un año por qué se ligó así.
   */
  static readonly NOTA_MINIMA = 4;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly puente: HrNominaPuenteService,
  ) {}

  private run<T>(fn: (trx: Knex.Transaction, tenant: string) => Promise<T>): Promise<T> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(tenant, (trx) => fn(trx, tenant));
  }

  /** Quién firma. Sin esto no se escribe: la base también lo exige (`person_aliases_manual_firma_ck`). */
  private quienFirma(): string {
    const quien = this.tenantCtx.get()?.userId;
    if (!quien) {
      throw new BadRequestException('Una resolución a mano se firma: no se pudo saber quién la hace.');
    }
    return String(quien);
  }

  // ── La cola ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Lo que falta por resolver, con lo necesario para decidir. No escribe nada.
   *
   * ⚠️ El empate se recalcula contra los padrones de HOY (los rechazos no se guardan, `[NE.2.3]`
   * regla 3), así que la cola siempre refleja el estado actual: si alguien da de alta a la persona
   * que faltaba, su caso desaparece solo en la siguiente carga.
   */
  async cola(dias?: number): Promise<HrColaNominaDto> {
    const calculado = await this.puente.calcula(dias);
    const codigos = calculado.rechazos.map((r) => r.codigo);
    const candidatos = [...new Set(calculado.rechazos.flatMap((r) => r.candidatos))];

    return this.run(async (trx, tenant) => {
      const [deNomina, deLaSuite] = await Promise.all([
        this.datosDeNomina(trx, codigos, calculado.resumen.dias),
        this.datosDeLaSuite(trx, tenant, candidatos),
      ]);

      const casos: HrCasoDeLaColaDto[] = calculado.rechazos.map((r) => {
        const n = deNomina.get(r.codigo);
        return {
          codigo: r.codigo,
          motivo: r.motivo,
          detalle: r.detalle,
          // Si el padrón no lo devuelve, se DECLARA desconocido; no se pone el código como nombre.
          nombreNomina: n?.nombre ?? '',
          ultimoPago: n?.ultimoPago ?? null,
          pagos: n?.pagos ?? 0,
          candidatos: r.candidatos.map((id) => deLaSuite.get(id)).filter((c): c is HrCandidatoDeLaSuiteDto => !!c),
        };
      });

      return { resumen: calculado.resumen, porMotivo: calculado.porMotivo, casos };
    });
  }

  /** Nombre, último pago y cuántas veces cobró en la ventana, por código. */
  private async datosDeNomina(
    trx: Knex.Transaction, codigos: string[], dias: number,
  ): Promise<Map<string, { nombre: string; ultimoPago: string | null; pagos: number }>> {
    if (!codigos.length) return new Map();
    // ⚠️ Con el constructor de consultas, no `raw`: knex **expande un arreglo** dentro de un `?`
    //    como lista separada por comas, así que un `= ANY(?)` no compila. `whereIn` lo hace bien.
    const rows = await trx('contpaqi_ods.v_nomina_pago_periodo as p')
      .join('contpaqi_ods.v_nomina_empleado as e', 'e.employee_code', 'p.employee_code')
      .whereIn('e.employee_code', codigos)
      .where('p.paid_on', '>', trx.raw(
        `(SELECT max(paid_on) FROM contpaqi_ods.v_nomina_pago_periodo) - (? || ' days')::interval`, [dias],
      ))
      .groupBy('e.employee_code')
      // ⛔⛔ `count(DISTINCT p.paid_on)`, NUNCA `count(*)`: esta vista registra **cada pago hasta
      //    tres veces** —exactamente 3.000 filas por persona y fecha entre 2019 y 2024— y dejó de
      //    hacerlo el 2026-10-30. Con `count(*)` la pantalla decía 18 pagos donde había 11
      //    (peor caso: 22 contra 13). Un pago es una FECHA, no una fila. → VERDAD_ABSOLUTA §40.8.
      .select(trx.raw(
        `e.employee_code AS codigo, max(e.full_name) AS nombre, max(p.paid_on)::text AS ultimo, count(DISTINCT p.paid_on)::int AS pagos`,
      ));
    return new Map(rows.map((r: Record<string, unknown>) => [
      String(r['codigo']),
      { nombre: String(r['nombre'] ?? ''), ultimoPago: r['ultimo'] === null ? null : String(r['ultimo']), pagos: Number(r['pagos']) },
    ]));
  }

  /** Nombre, estado y códigos ya ligados, por usuario de la Suite. */
  private async datosDeLaSuite(
    trx: Knex.Transaction, tenant: string, ids: string[],
  ): Promise<Map<string, HrCandidatoDeLaSuiteDto>> {
    if (!ids.length) return new Map();
    const [gente, alias] = await Promise.all([
      trx('identity.users').where({ tenant_id: tenant }).whereIn('id', ids).select('id', 'nombre', 'status'),
      trx('hr.person_aliases')
        .where({ tenant_id: tenant, system: 'contpaqi', is_active: true })
        .whereIn('user_id', ids)
        .select('user_id', 'external_code'),
    ]);
    const porUsuario = new Map<string, string[]>();
    for (const a of alias) {
      const k = String(a['user_id']);
      const ya = porUsuario.get(k);
      if (ya) ya.push(String(a['external_code']));
      else porUsuario.set(k, [String(a['external_code'])]);
    }
    return new Map(gente.map((g) => {
      const id = String(g['id']);
      return [id, { userId: id, nombre: String(g['nombre'] ?? ''), status: String(g['status'] ?? ''), codigosYaLigados: porUsuario.get(id) ?? [] }];
    }));
  }

  // ── La resolución ────────────────────────────────────────────────────────────────────────────

  /**
   * Liga un código de nómina a una persona, **a mano y firmado**. Todo en una transacción.
   *
   * Idempotente: si ya está ligado a esa misma persona, no escribe y devuelve el alias que hay.
   * ⛔ Si está ligado a OTRA persona, no se pisa sin que quien resuelve diga a quién apuntaba —ese
   * es el único caso en que cambiar un alias cambia a quién se le paga—.
   */
  async resuelve(b: HrResuelveCasoDto): Promise<HrResolucionDto> {
    const codigo = String(b?.codigo ?? '').trim();
    const userId = String(b?.userId ?? '').trim();
    const nota = String(b?.nota ?? '').trim();
    if (!codigo) throw new BadRequestException('Falta el código de nómina.');
    if (!userId) throw new BadRequestException('Falta a quién se liga.');
    if (nota.length < HrNominaColaService.NOTA_MINIMA) {
      throw new BadRequestException('Escribí por qué este código es esta persona: la nota es la firma.');
    }
    const quien = this.quienFirma();

    return this.run(async (trx, tenant) => {
      // 1. El código tiene que ser de alguien a quien se le paga. Ligar un código que nadie cobra
      //    es crear un alias que no explica ningún pago.
      const { rows: [existe] } = await trx.raw(
        `SELECT 1 AS hay FROM contpaqi_ods.v_nomina_empleado WHERE employee_code = ? LIMIT 1`, [codigo],
      );
      if (!existe) throw new NotFoundException(`El código ${codigo} no está en el padrón de nómina.`);

      // 2. La persona tiene que existir en la Suite, de este tenant y no borrada. La FK lo diría
      //    después, pero con un error que no se puede leer en una pantalla.
      const persona = await trx('identity.users')
        .where({ tenant_id: tenant, id: userId }).whereNull('deleted_at').first('id', 'status');
      if (!persona) throw new NotFoundException('Esa persona no existe en la Suite.');

      // 3. Qué hay hoy para ese código.
      const actual = await trx('hr.person_aliases')
        .where({ tenant_id: tenant, system: 'contpaqi', external_code: codigo, is_active: true })
        .first('id', 'user_id');

      if (actual && String(actual['user_id']) === userId) {
        // Idempotente: ya está dicho, y dice lo mismo.
        return { codigo, userId, aliasId: String(actual['id']), reemplazado: null };
      }

      let reemplazado: string | null = null;
      if (actual) {
        const apunta = String(actual['user_id']);
        const declarado = String(b?.reemplazaA ?? '').trim();
        if (!declarado) {
          throw new ConflictException(
            'Ese código ya está ligado a otra persona. Para corregirlo, mandá a quién apunta hoy.',
          );
        }
        if (declarado !== apunta) {
          // ⛔ Cambió entre que la pantalla lo mostró y ahora: no se pisa lo que no se vio.
          throw new ConflictException(
            'Ese código cambió mientras resolvías: volvé a cargar la cola antes de corregirlo.',
          );
        }
        // Se DESACTIVA, no se borra: el único índice es parcial sobre `is_active`, así que esto
        // libera el código y conserva a quién apuntaba antes.
        await trx('hr.person_aliases').where({ id: actual['id'] }).update({
          is_active: false,
          matched_note: trx.raw(`coalesce(matched_note, '') || ?`, [` · [NE.2.5] reemplazado el ${new Date().toISOString().slice(0, 10)}`]),
          updated_by: quien,
          updated_at: trx.fn.now(),
        });
        reemplazado = String(actual['id']);
      }

      const [puesto] = await trx('hr.person_aliases').insert({
        tenant_id: tenant,
        user_id: userId,
        system: 'contpaqi',
        external_code: codigo,
        matched_by: 'manual',
        matched_note: nota,
        created_by: quien,
        updated_by: quien,
      }).returning('id');

      this.logger.log(
        `[NE.2.5] alias manual: código ${codigo} → usuario ${userId}` +
          (reemplazado ? ` (reemplaza ${reemplazado})` : ''),
      );
      return { codigo, userId, aliasId: String((puesto as Record<string, unknown>)['id']), reemplazado };
    });
  }
}
