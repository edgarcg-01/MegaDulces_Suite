import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  HrConflictoAliasDto, HrMotivoRechazoPuente, HrPuenteNominaDto, HrPuenteRegistroDto, HrRechazoPuenteDto,
} from '@megadulces/contracts';
import { notaDelAlias, tiendePuente, type PersonaDeLaSuite, type PersonaDeNomina } from './puente-padrones';

/**
 * Fase RH · frente NE · `[NE.2.3]` — EL SERVICIO DEL PUENTE: quién escribe `hr.person_aliases`.
 *
 * La decisión de a quién corresponde cada código vive en `puente-padrones.ts` (lógica pura, 11
 * pruebas y cruzada contra prod). Acá sólo está lo que esa pieza no puede hacer: **leer las dos
 * puntas y escribir**.
 *
 * ── Por qué existe este servicio y no un script ────────────────────────────────────────────────
 * `hr.person_aliases` concede `INSERT` **sólo a `app_runtime`** (medido con `has_table_privilege`
 * el 2026-11-24). No es un permiso que falte: es que **el que escribe es la aplicación**, con su
 * clave de permiso y su rastro, no una laptop con un script. *Cifra: la tabla nació el 2026-11-23
 * y llegó al 24 con 0 filas, llenable y sin llenador.*
 *
 * ── La fuente ──────────────────────────────────────────────────────────────────────────────────
 * `contpaqi_ods.v_nomina_empleado` + `v_nomina_pago_periodo`, que ya están **dentro de la base** y
 * las lee `app_runtime`. No hay archivo, no hay importer. ⭐ El universo se toma de **quién cobró**,
 * no del campo `status` del padrón: de 248 personas pagadas, ese campo marca 32 como baja y 34 como
 * «R» (`[NE.0.10]`: «activo» en un padrón no significa nada).
 *
 * ── Tres reglas de escritura ───────────────────────────────────────────────────────────────────
 *  1. **Idempotente**: correrlo dos veces no inserta de nuevo.
 *  2. ⛔ **No pisa.** Si un código ya tiene alias apuntando a OTRA persona, no se toca: se
 *     **reporta como conflicto**. Reescribirlo en silencio cambiaría a quién se le paga.
 *  3. ⭐ **Los rechazos no se guardan: se derivan.** Son una función pura de los dos padrones de
 *     hoy, así que materializarlos sería una copia que envejece (regla 2). Se devuelven, y la cola
 *     de `[NE.2.5]` los vuelve a pedir cuando los necesite.
 */
@Injectable()
export class HrNominaPuenteService {
  private readonly logger = new Logger(HrNominaPuenteService.name);

  /** Ventana por defecto del universo: quién cobró en los últimos N días. */
  static readonly DIAS_POR_DEFECTO = 90;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private run<T>(fn: (trx: Knex.Transaction, tenant: string) => Promise<T>): Promise<T> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(tenant, (trx) => fn(trx, tenant));
  }

  private static validaDias(dias: number | undefined): number {
    const d = dias === undefined ? HrNominaPuenteService.DIAS_POR_DEFECTO : Math.round(Number(dias));
    if (!Number.isFinite(d) || d < 1 || d > 400) {
      throw new BadRequestException('La ventana va de 1 a 400 días.');
    }
    return d;
  }

  /** El padrón de la Suite: internos no borrados, con su estado tal cual. */
  private async suite(trx: Knex.Transaction, tenant: string): Promise<PersonaDeLaSuite[]> {
    const filas = await trx('identity.users')
      .where({ tenant_id: tenant, kind: 'interno' })
      .whereNull('deleted_at')
      .select('id', 'nombre', 'status');
    return filas.map((f) => ({ id: String(f['id']), nombre: String(f['nombre'] ?? ''), status: String(f['status'] ?? '') }));
  }

  /**
   * El padrón de nómina: quien COBRÓ en la ventana. ⚠️ No se filtra por `status` del empleado a
   * propósito — el hecho es el pago.
   */
  private async padron(trx: Knex.Transaction, dias: number): Promise<{ gente: PersonaDeNomina[]; ultimoPago: string | null }> {
    const { rows } = await trx.raw(
      `SELECT e.employee_code AS codigo, e.full_name AS nombre,
              (SELECT max(paid_on)::text FROM contpaqi_ods.v_nomina_pago_periodo) AS ultimo
         FROM contpaqi_ods.v_nomina_pago_periodo p
         JOIN contpaqi_ods.v_nomina_empleado e ON e.employee_code = p.employee_code
        WHERE p.paid_on > (SELECT max(paid_on) FROM contpaqi_ods.v_nomina_pago_periodo) - (? || ' days')::interval
        GROUP BY 1, 2, 3`,
      [dias],
    );
    const gente: PersonaDeNomina[] = rows.map((r: Record<string, unknown>) => ({
      codigo: String(r['codigo']),
      nombreCompleto: String(r['nombre'] ?? ''),
    }));
    return { gente, ultimoPago: rows.length ? String(rows[0]['ultimo']) : null };
  }

  /** Lo que ya está registrado para esos códigos: código → a quién apunta. */
  private async yaRegistrados(trx: Knex.Transaction, tenant: string, codigos: string[]): Promise<Map<string, string>> {
    if (!codigos.length) return new Map();
    const filas = await trx('hr.person_aliases')
      .where({ tenant_id: tenant, system: 'contpaqi', is_active: true })
      .whereIn('external_code', codigos)
      .select('external_code', 'user_id');
    return new Map(filas.map((f) => [String(f['external_code']), String(f['user_id'])]));
  }

  private static porMotivo(rechazos: HrRechazoPuenteDto[]): Record<HrMotivoRechazoPuente, number> {
    const base: Record<HrMotivoRechazoPuente, number> = {
      ambiguo: 0, 'solo-baja': 0, 'sin-candidato': 0, juicio: 0, choque: 0,
    };
    for (const r of rechazos) base[r.motivo]++;
    return base;
  }

  /** Calcula el puente sin escribir nada. */
  async calcula(dias?: number): Promise<HrPuenteNominaDto> {
    const d = HrNominaPuenteService.validaDias(dias);
    return this.run(async (trx, tenant) => {
      const [{ gente, ultimoPago }, suite] = await Promise.all([this.padron(trx, d), this.suite(trx, tenant)]);
      const puente = tiendePuente(gente, suite);
      const registrados = await this.yaRegistrados(trx, tenant, puente.empates.map((e) => e.codigo));
      const conflictos: HrConflictoAliasDto[] = puente.empates
        .filter((e) => registrados.has(e.codigo) && registrados.get(e.codigo) !== e.userId)
        .map((e) => ({ codigo: e.codigo, userIdRegistrado: String(registrados.get(e.codigo)), userIdCalculado: e.userId }));
      const rechazos = puente.rechazos as HrRechazoPuenteDto[];
      return {
        resumen: { fuente: 'contpaqi', dias: d, ultimoPago, ...puente.resumen },
        porMotivo: HrNominaPuenteService.porMotivo(rechazos),
        rechazos,
        conflictos,
      };
    });
  }

  /**
   * Calcula y **escribe** los aliases que falten. Idempotente; nunca pisa uno que apunta a otra
   * persona. Todo en una transacción: o quedan todos, o no queda ninguno.
   */
  async registra(dias?: number): Promise<HrPuenteRegistroDto> {
    const d = HrNominaPuenteService.validaDias(dias);
    return this.run(async (trx, tenant) => {
      const [{ gente, ultimoPago }, suite] = await Promise.all([this.padron(trx, d), this.suite(trx, tenant)]);
      const puente = tiendePuente(gente, suite);
      const registrados = await this.yaRegistrados(trx, tenant, puente.empates.map((e) => e.codigo));
      const quien = this.tenantCtx.get()?.userId ?? null;
      const hoy = new Date().toISOString().slice(0, 10);

      const conflictos: HrConflictoAliasDto[] = [];
      const nuevos: Array<Record<string, unknown>> = [];
      let yaEstaban = 0;
      for (const e of puente.empates) {
        const actual = registrados.get(e.codigo);
        if (actual === e.userId) { yaEstaban++; continue; }
        if (actual !== undefined) {
          // ⛔ Apunta a otra persona: no se pisa. Cambiarlo en silencio cambiaría a quién se paga.
          conflictos.push({ codigo: e.codigo, userIdRegistrado: actual, userIdCalculado: e.userId });
          continue;
        }
        nuevos.push({
          tenant_id: tenant,
          user_id: e.userId,
          system: 'contpaqi',
          external_code: e.codigo,
          matched_by: 'nombre',
          matched_note: notaDelAlias(e, { item: 'NE.2.3', fecha: hoy, sistema: 'ContPAQi' }),
          created_by: quien,
          updated_by: quien,
        });
      }

      let insertados = 0;
      if (nuevos.length) {
        // `onConflict().ignore()` por si otra corrida simultánea ganó la carrera: el único es
        // `(tenant_id, system, external_code) WHERE is_active`.
        const puestos = await trx('hr.person_aliases').insert(nuevos).onConflict().ignore().returning('id');
        insertados = puestos.length;
      }
      const rechazos = puente.rechazos as HrRechazoPuenteDto[];
      this.logger.log(
        `[NE.2.3] puente ContPAQi: universo ${puente.resumen.universo}, ligados ${puente.resumen.ligados}, ` +
          `insertados ${insertados}, ya estaban ${yaEstaban}, conflictos ${conflictos.length}, rechazos ${rechazos.length}`,
      );
      return {
        resumen: { fuente: 'contpaqi', dias: d, ultimoPago, ...puente.resumen },
        porMotivo: HrNominaPuenteService.porMotivo(rechazos),
        rechazos,
        conflictos,
        insertados,
        yaEstaban,
        noTocados: conflictos.length,
      };
    });
  }
}
