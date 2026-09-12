import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * `[AU.0]` — La ORGANIZACIÓN por API: puestos, cadena de mando y responsabilidades.
 *
 * ── Por qué un service aparte ───────────────────────────────────────────────
 * `UsersService` son 2,566 líneas y responde por la PERSONA. Esto responde por
 * la ESTRUCTURA en la que la persona encaja. Meterlo ahí lo volvería el archivo
 * que nadie quiere abrir, y ya casi lo es.
 *
 * ── El hueco que cierra, medido ─────────────────────────────────────────────
 * La Fase OR construyó el modelo entero en la base y **no le dio superficie**:
 *
 *   · `identity.positions` · `departments` · `responsibilities`
 *     `position_responsibilities`  → sólo LECTURA por API. Cero create/update/delete.
 *   · `identity.user_responsibilities`  → **cero endpoints de cualquier tipo**.
 *     Se lee únicamente dentro del privado `responsabilidadesDe()`.
 *   · `identity.v_position_history`     → **cero referencias** en `libs/` y `apps/`.
 *
 * Consecuencia concreta: el reparto de conciliación de `[SN.17]` —Ivonne los
 * ingresos, Mayra los egresos— **se hizo por migración**, porque no había otra
 * forma de escribirlo. Administrar la organización no puede exigir un deploy.
 *
 * ── ⛔ La regla que este service NO cruza ───────────────────────────────────
 *   el PERMISO decide si podés abrirlo · la RESPONSABILIDAD decide si es tuyo
 *
 * Asignar una responsabilidad **no otorga ningún permiso**. Cuando el puesto
 * responde de algo que su rol no abre, se DEVUELVE el desacuerdo (`abre: false`)
 * para que la pantalla lo muestre y mande a `/admin/roles`. Repararlo acá sería
 * un cuarto sistema de autorización — el defecto que ADR-054 retiró tras medir
 * 4 compuertas muertas por tener la autorización en dos lugares.
 *
 * ── Tenant explícito, siempre ───────────────────────────────────────────────
 * `KNEX_CONNECTION` conecta como superusuario, y un superusuario **bypassea RLS
 * incluso con FORCE ROW LEVEL SECURITY**. Toda query lleva `tenant_id` a mano.
 * ⚠️ `identity.responsibilities` es la excepción: es catálogo de PRODUCTO (sin
 * `tenant_id`, sin RLS), mismo patrón que `identity.scope_dimensions`.
 */

/** Lo que este service necesita de `req.user` para firmar la bitácora. */
export interface OrgRequester {
  sub: string;
  username?: string;
  permissions?: Record<string, boolean> | null;
  role_name?: string;
}

export interface PositionWriteInput {
  code?: string;
  name?: string;
  department_code?: string | null;
  default_role?: string | null;
  default_complements?: string[];
  scope_axis?: string | null;
  orden?: number;
  org_labels?: string[];
}

/** Los ejes que el CHECK `positions_scope_axis_check` admite. */
const EJES_VALIDOS = new Set(['ruta', 'zona', 'sucursal', 'red', 'cartera', 'cliente']);

/** `identity.user_responsibilities.accion` — lo que el CHECK admite. */
const ACCIONES = new Set(['suma', 'resta']);

@Injectable()
export class OrgService {
  private readonly logger = new Logger(OrgService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private get tenantId(): string {
    return this.tenantCtx.requireTenantId();
  }

  /**
   * Bitácora append-only. **Nunca hace fallar la operación**: si el evento no se
   * pudo escribir, se loguea y se sigue — mismo criterio que
   * `UsersService.recordEvent`. Perder el registro es malo; deshacer un cambio
   * que ya se aplicó por no poder registrarlo es peor.
   */
  private async recordEvent(
    trx: Knex | Knex.Transaction,
    userId: string,
    event: string,
    detalle: Record<string, unknown>,
    requester?: OrgRequester,
  ): Promise<void> {
    try {
      await trx('identity.user_events').insert({
        tenant_id: this.tenantId,
        user_id: userId,
        event,
        detalle: JSON.stringify(detalle),
        actor_user_id: requester?.sub ?? null,
        actor_username: requester?.username ?? null,
      });
    } catch (e) {
      this.logger.error(`No se pudo registrar el evento ${event}: ${(e as Error).message}`);
    }
  }

  // ══ PUESTOS ═══════════════════════════════════════════════════════════════

  /**
   * El catálogo con lo que la pantalla necesita para decidir sin un segundo
   * viaje: cuánta gente lo ocupa, qué propone, de quién cuelga y de cuántas
   * cosas responde.
   */
  async listPositions() {
    const tenantId = this.tenantId;
    const { rows } = await this.knex.raw(
      `SELECT p.code, p.name, p.department_code, d.name AS department_name,
              d.scope_axis AS department_scope_axis,
              p.default_role, p.default_complements, p.scope_axis, p.orden,
              p.org_labels, p.reports_to_position_code,
              jefe.name AS reports_to_name,
              COALESCE(p.scope_axis, d.scope_axis) AS eje_efectivo,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code
                  AND u.deleted_at IS NULL AND u.kind = 'interno') AS personas,
              (SELECT count(*)::int FROM identity.position_responsibilities pr
                WHERE pr.tenant_id = p.tenant_id AND pr.position_code = p.code
                  AND pr.deleted_at IS NULL) AS responsabilidades,
              (SELECT count(*)::int FROM identity.positions h
                WHERE h.tenant_id = p.tenant_id AND h.reports_to_position_code = p.code
                  AND h.deleted_at IS NULL) AS puestos_a_cargo
         FROM identity.positions p
         LEFT JOIN identity.departments d
           ON d.tenant_id = p.tenant_id AND d.code = p.department_code AND d.deleted_at IS NULL
         LEFT JOIN identity.positions jefe
           ON jefe.tenant_id = p.tenant_id AND jefe.code = p.reports_to_position_code
          AND jefe.deleted_at IS NULL
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
        ORDER BY p.orden, p.code`,
      [tenantId],
    );
    return rows;
  }

  async getPosition(code: string) {
    const rows = await this.listPositions();
    const pos = rows.find((r: { code: string }) => r.code === code);
    if (!pos) throw new NotFoundException(`El puesto "${code}" no existe.`);
    return {
      ...pos,
      responsabilidades_detalle: await this.positionResponsibilities(code),
      ocupantes: await this.knex('identity.users')
        .where({ tenant_id: this.tenantId, position_code: code, kind: 'interno' })
        .whereNull('deleted_at')
        .select('id', 'username', 'nombre', 'role_name', 'warehouse_code', 'status')
        .orderBy('username'),
    };
  }

  /**
   * Valida lo que la base rechazaría con un 500 ilegible, para devolver un 400
   * que dice qué está mal. No reimplementa los CHECK: los anticipa.
   */
  private async assertPositionInput(input: PositionWriteInput, code?: string) {
    const tenantId = this.tenantId;

    if (input.scope_axis != null && !EJES_VALIDOS.has(input.scope_axis)) {
      throw new BadRequestException(
        `El eje "${input.scope_axis}" no existe. Los válidos: ${[...EJES_VALIDOS].join(', ')}.`,
      );
    }

    if (input.department_code != null) {
      const dep = await this.knex('identity.departments')
        .where({ tenant_id: tenantId, code: input.department_code })
        .whereNull('deleted_at')
        .first('code');
      if (!dep) throw new BadRequestException(`El departamento "${input.department_code}" no existe.`);
    }

    // El rol propuesto y los complementos tienen que existir. La FK del rol es
    // `ON DELETE SET NULL`, así que sin esta barrera un typo dejaría el puesto
    // proponiendo NULL en silencio, que es indistinguible de "no propone nada".
    const roles = [
      ...(input.default_role ? [input.default_role] : []),
      ...(input.default_complements ?? []),
    ];
    if (roles.length) {
      const existen = await this.knex('identity.role_permissions')
        .where({ tenant_id: tenantId })
        .whereIn('role_name', roles)
        .pluck('role_name');
      const faltan = roles.filter((r) => !existen.includes(r));
      if (faltan.length) {
        throw new BadRequestException(`Estos roles no existen: ${faltan.join(', ')}.`);
      }
    }

    // Un complemento que repite el perfil base no suma nada y confunde la ficha.
    if (input.default_role && input.default_complements?.includes(input.default_role)) {
      throw new BadRequestException(
        `"${input.default_role}" ya es el perfil base del puesto: no puede ser además un complemento.`,
      );
    }

    if (code && input.code && input.code !== code) {
      throw new BadRequestException('El código de un puesto no se renombra: creá otro y movés la gente.');
    }
  }

  async createPosition(input: PositionWriteInput, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const code = (input.code ?? '').trim();
    if (!code) throw new BadRequestException('Falta el código del puesto.');
    if (!/^[a-z0-9_]+$/.test(code)) {
      throw new BadRequestException(
        'El código va en minúsculas, sin espacios ni acentos (letras, números y guion bajo).',
      );
    }
    if (!(input.name ?? '').trim()) throw new BadRequestException('Falta el nombre del puesto.');

    await this.assertPositionInput(input);

    const yaEsta = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .first('code', 'deleted_at');
    if (yaEsta) {
      throw new ConflictException(
        yaEsta.deleted_at
          ? `El puesto "${code}" existe pero está dado de baja. Reactivalo en vez de crearlo de nuevo.`
          : `El puesto "${code}" ya existe.`,
      );
    }

    const [pos] = await this.knex('identity.positions')
      .insert({
        tenant_id: tenantId,
        code,
        name: input.name!.trim(),
        department_code: input.department_code ?? null,
        default_role: input.default_role ?? null,
        default_complements: input.default_complements ?? [],
        scope_axis: input.scope_axis ?? null,
        orden: input.orden ?? 0,
        org_labels: input.org_labels ?? [],
        created_by: requester.sub,
        updated_by: requester.sub,
      })
      .returning('*');

    await this.recordEvent(this.knex, requester.sub, 'puesto_creado', { code, name: pos.name }, requester);
    return pos;
  }

  async updatePosition(code: string, input: PositionWriteInput, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const actual = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .whereNull('deleted_at')
      .first();
    if (!actual) throw new NotFoundException(`El puesto "${code}" no existe.`);

    await this.assertPositionInput(input, code);

    const cambios: Record<string, unknown> = { updated_by: requester.sub, updated_at: this.knex.fn.now() };
    for (const campo of [
      'name',
      'department_code',
      'default_role',
      'default_complements',
      'scope_axis',
      'orden',
      'org_labels',
    ] as const) {
      if (input[campo] !== undefined) cambios[campo] = input[campo];
    }

    const [pos] = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .update(cambios)
      .returning('*');

    await this.recordEvent(
      this.knex,
      requester.sub,
      'puesto_editado',
      { code, antes: this.soloCamposTocados(actual, input), despues: this.soloCamposTocados(pos, input) },
      requester,
    );
    return pos;
  }

  /** Para que la bitácora no guarde la fila entera cuando cambió un campo. */
  private soloCamposTocados(fila: Record<string, unknown>, input: PositionWriteInput) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(input)) if (k in fila) out[k] = fila[k];
    return out;
  }

  /**
   * Baja del puesto. **Se niega si alguien lo ocupa o si es jefe de otro.**
   *
   * No es burocracia: la FK `positions_reports_to_fk` es `ON DELETE SET NULL`,
   * así que borrar un puesto intermedio **desprendería en silencio** a todos sus
   * subordinados del organigrama. Lo mismo que le pasa a un rol cuando se borra
   * y un puesto lo proponía.
   */
  async deletePosition(code: string, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const pos = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .whereNull('deleted_at')
      .first('code', 'name');
    if (!pos) throw new NotFoundException(`El puesto "${code}" no existe.`);

    const ocupantes = await this.knex('identity.users')
      .where({ tenant_id: tenantId, position_code: code, kind: 'interno' })
      .whereNull('deleted_at')
      .pluck('username');
    if (ocupantes.length) {
      throw new ConflictException(
        `No se puede dar de baja "${code}": lo ocupan ${ocupantes.length} persona/s ` +
          `(${ocupantes.slice(0, 5).join(', ')}${ocupantes.length > 5 ? '…' : ''}). Movelas primero.`,
      );
    }

    const aCargo = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, reports_to_position_code: code })
      .whereNull('deleted_at')
      .pluck('code');
    if (aCargo.length) {
      throw new ConflictException(
        `No se puede dar de baja "${code}": es el jefe de ${aCargo.length} puesto/s ` +
          `(${aCargo.join(', ')}). Quedarían sin jefe. Reasignalos primero.`,
      );
    }

    await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .update({ deleted_at: this.knex.fn.now(), deleted_by: requester.sub });

    await this.recordEvent(this.knex, requester.sub, 'puesto_dado_de_baja', { code, name: pos.name }, requester);
    return { code, baja: true };
  }

  /**
   * La arista de mando. El ciclo lo rechaza el trigger `positions_sin_ciclo`
   * (`[OR.1]`), que es SECURITY DEFINER porque `identity.positions` tiene FORCE
   * RLS — *un candado que no ve las filas no encuentra el ciclo*. Acá sólo se
   * traduce ese error a un 400 que se entiende.
   */
  async setReportsTo(code: string, parentCode: string | null, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const pos = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .whereNull('deleted_at')
      .first('code', 'reports_to_position_code');
    if (!pos) throw new NotFoundException(`El puesto "${code}" no existe.`);

    if (parentCode) {
      if (parentCode === code) {
        throw new BadRequestException('Un puesto no puede reportarse a sí mismo.');
      }
      const jefe = await this.knex('identity.positions')
        .where({ tenant_id: tenantId, code: parentCode })
        .whereNull('deleted_at')
        .first('code');
      if (!jefe) throw new BadRequestException(`El puesto jefe "${parentCode}" no existe.`);
    }

    try {
      await this.knex('identity.positions')
        .where({ tenant_id: tenantId, code })
        .update({
          reports_to_position_code: parentCode,
          updated_by: requester.sub,
          updated_at: this.knex.fn.now(),
        });
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/ciclo|cycle|check_violation/i.test(msg)) {
        throw new BadRequestException(
          `Colgar "${code}" de "${parentCode}" cierra un ciclo en la cadena de mando: ` +
            `"${parentCode}" ya depende de "${code}", directa o indirectamente.`,
        );
      }
      throw e;
    }

    await this.recordEvent(
      this.knex,
      requester.sub,
      'cadena_de_mando_cambiada',
      { position_code: code, antes: pos.reports_to_position_code, ahora: parentCode },
      requester,
    );
    return { code, reports_to_position_code: parentCode };
  }

  // ══ RESPONSABILIDADES ═════════════════════════════════════════════════════

  /**
   * El catálogo de producto, con **cuántos puestos y cuántas personas** responden
   * de cada cosa.
   *
   * ⚠️ `claves` puede venir en 0 y NO significa "no necesita permiso": significa
   * que **nadie declaró cuál la abre**, y entonces el cruce
   * responsabilidad × permiso no la puede juzgar. Las 2 de conciliación de
   * `[SN.17]` están así. Se devuelve `claves_declaradas: false` para que la
   * pantalla lo diga en vez de pintarlo como verde.
   */
  async listResponsibilities() {
    const tenantId = this.tenantId;
    const { rows } = await this.knex.raw(
      `SELECT r.key, r.label, r.descripcion, r.dimension, r.orden, r.permission_keys,
              (COALESCE(array_length(r.permission_keys, 1), 0) > 0) AS claves_declaradas,
              (SELECT count(*)::int FROM identity.position_responsibilities pr
                WHERE pr.tenant_id = ? AND pr.responsibility_key = r.key
                  AND pr.deleted_at IS NULL) AS puestos,
              (SELECT count(*)::int FROM identity.user_responsibilities ur
                WHERE ur.tenant_id = ? AND ur.responsibility_key = r.key
                  AND ur.deleted_at IS NULL AND ur.accion = 'suma'
                  AND (ur.valid_to IS NULL OR ur.valid_to >= CURRENT_DATE)) AS personas_directas
         FROM identity.responsibilities r
        ORDER BY r.orden, r.key`,
      [tenantId, tenantId],
    );
    return rows;
  }

  /**
   * De qué responde un puesto, y **si su perfil puede abrirlo**.
   *
   * ⛔ `abre` es un DIAGNÓSTICO, no una compuerta. Se calcula cruzando
   * `responsibilities.permission_keys` contra el mapa del `default_role` del
   * puesto. Cuando da `false`, la respuesta correcta es arreglar el rol en
   * `/admin/roles` — no que la responsabilidad conceda el permiso.
   */
  async positionResponsibilities(code: string) {
    const tenantId = this.tenantId;
    const { rows } = await this.knex.raw(
      `SELECT pr.responsibility_key, r.label, r.dimension, r.permission_keys,
              pr.es_principal,
              (COALESCE(array_length(r.permission_keys, 1), 0) > 0) AS claves_declaradas,
              CASE
                WHEN COALESCE(array_length(r.permission_keys, 1), 0) = 0 THEN NULL
                WHEN p.default_role IS NULL THEN FALSE
                ELSE EXISTS (
                  SELECT 1 FROM identity.role_permissions rp
                   WHERE rp.tenant_id = pr.tenant_id AND rp.role_name = p.default_role
                     AND EXISTS (
                       SELECT 1 FROM unnest(r.permission_keys) k
                        WHERE rp.permissions ->> k = 'true'))
              END AS abre
         FROM identity.position_responsibilities pr
         JOIN identity.responsibilities r ON r.key = pr.responsibility_key
         JOIN identity.positions p
           ON p.tenant_id = pr.tenant_id AND p.code = pr.position_code AND p.deleted_at IS NULL
        WHERE pr.tenant_id = ? AND pr.position_code = ? AND pr.deleted_at IS NULL
        ORDER BY pr.es_principal DESC, r.orden`,
      [tenantId, code],
    );
    return rows;
  }

  async addPositionResponsibility(
    code: string,
    key: string,
    esPrincipal: boolean,
    requester: OrgRequester,
  ) {
    const tenantId = this.tenantId;

    const pos = await this.knex('identity.positions')
      .where({ tenant_id: tenantId, code })
      .whereNull('deleted_at')
      .first('code');
    if (!pos) throw new NotFoundException(`El puesto "${code}" no existe.`);

    const resp = await this.knex('identity.responsibilities').where({ key }).first('key', 'label');
    if (!resp) throw new BadRequestException(`La responsabilidad "${key}" no está en el catálogo.`);

    // Un solo PRINCIPAL por responsabilidad: si hay dos, "¿quién responde?" tiene
    // dos respuestas y el reparto de [OR.3] no sabe a cuál apuntar.
    if (esPrincipal) {
      const otro = await this.knex('identity.position_responsibilities')
        .where({ tenant_id: tenantId, responsibility_key: key, es_principal: true })
        .whereNull('deleted_at')
        .whereNot('position_code', code)
        .first('position_code');
      if (otro) {
        throw new ConflictException(
          `"${resp.label}" ya tiene un responsable principal: el puesto "${otro.position_code}". ` +
            'Bajalo a secundario primero, o agregá éste como secundario.',
        );
      }
    }

    // El índice único es PARCIAL (`WHERE deleted_at IS NULL`), así que un
    // `onConflict` no lo ve. Se revive la fila dada de baja en vez de duplicarla.
    const previa = await this.knex('identity.position_responsibilities')
      .where({ tenant_id: tenantId, position_code: code, responsibility_key: key })
      .first('id', 'deleted_at');

    if (previa && !previa.deleted_at) {
      await this.knex('identity.position_responsibilities')
        .where({ id: previa.id })
        .update({ es_principal: esPrincipal, updated_by: requester.sub, updated_at: this.knex.fn.now() });
    } else if (previa) {
      await this.knex('identity.position_responsibilities').where({ id: previa.id }).update({
        deleted_at: null,
        deleted_by: null,
        es_principal: esPrincipal,
        updated_by: requester.sub,
        updated_at: this.knex.fn.now(),
      });
    } else {
      await this.knex('identity.position_responsibilities').insert({
        tenant_id: tenantId,
        position_code: code,
        responsibility_key: key,
        es_principal: esPrincipal,
        created_by: requester.sub,
        updated_by: requester.sub,
      });
    }

    await this.recordEvent(
      this.knex,
      requester.sub,
      'responsabilidad_de_puesto_asignada',
      { position_code: code, responsibility_key: key, es_principal: esPrincipal },
      requester,
    );
    return this.positionResponsibilities(code);
  }

  async removePositionResponsibility(code: string, key: string, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const n = await this.knex('identity.position_responsibilities')
      .where({ tenant_id: tenantId, position_code: code, responsibility_key: key })
      .whereNull('deleted_at')
      .update({ deleted_at: this.knex.fn.now(), deleted_by: requester.sub });
    if (!n) throw new NotFoundException(`El puesto "${code}" no responde de "${key}".`);

    await this.recordEvent(
      this.knex,
      requester.sub,
      'responsabilidad_de_puesto_retirada',
      { position_code: code, responsibility_key: key },
      requester,
    );
    return this.positionResponsibilities(code);
  }

  // ══ RESPONSABILIDAD POR PERSONA ═══════════════════════════════════════════

  /**
   * Lo que responde una persona: lo HEREDADO del puesto y lo PROPIO.
   *
   * Se devuelven separados a propósito. Mezclarlos haría invisible la única
   * pregunta que importa al auditar: *¿esto le toca por el puesto, o alguien se
   * lo asignó a ella con nombre y fecha?*
   */
  async userResponsibilities(userId: string) {
    const tenantId = this.tenantId;

    const user = await this.knex('identity.users')
      .where({ tenant_id: tenantId, id: userId })
      .first('id', 'username', 'position_code');
    if (!user) throw new NotFoundException('El usuario no existe.');

    const { rows: heredadas } = await this.knex.raw(
      `SELECT pr.responsibility_key, r.label, r.dimension, pr.es_principal
         FROM identity.position_responsibilities pr
         JOIN identity.responsibilities r ON r.key = pr.responsibility_key
        WHERE pr.tenant_id = ? AND pr.position_code = ? AND pr.deleted_at IS NULL
        ORDER BY r.orden`,
      [tenantId, user.position_code ?? ' '],
    );

    const { rows: propias } = await this.knex.raw(
      `SELECT ur.id, ur.responsibility_key, r.label, r.dimension, ur.accion, ur.nota,
              ur.valid_from, ur.valid_to,
              (ur.valid_to IS NULL OR ur.valid_to >= CURRENT_DATE) AS vigente,
              ur.created_at, ur.created_by
         FROM identity.user_responsibilities ur
         JOIN identity.responsibilities r ON r.key = ur.responsibility_key
        WHERE ur.tenant_id = ? AND ur.user_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.orden, ur.valid_from DESC`,
      [tenantId, userId],
    );

    // El efectivo: el puesto pone la base, la excepción por persona gana.
    const efectivo = new Set<string>(
      heredadas.map((h: { responsibility_key: string }) => h.responsibility_key),
    );
    for (const p of propias) {
      if (!p.vigente) continue;
      if (p.accion === 'suma') efectivo.add(p.responsibility_key);
      else efectivo.delete(p.responsibility_key);
    }

    return {
      user_id: userId,
      username: user.username,
      position_code: user.position_code,
      heredadas,
      propias,
      efectivo: [...efectivo],
    };
  }

  /**
   * La excepción por persona. `nota` es **obligatoria** y el CHECK
   * `user_responsibilities_nota_obligatoria` la exige no-vacía en la base.
   *
   * ── Por qué la nota no es opcional ──────────────────────────────────────
   * `identity.user_roles` ya mostró en qué termina un override sin regla: **133
   * de 139 filas son un espejo** del rol que ya está en `users.role_name`, y
   * nadie sabe cuáles de las 6 restantes son intencionales. La nota es lo que
   * evita que esta tabla se vuelva eso. La de `[SN.17]` dice por qué el reparto
   * fue por persona y no por puesto, y hasta qué haría falta para corregirlo.
   *
   * ⚠️ La tabla **no tiene índice único** por (persona, responsabilidad): se
   * cierra la vigencia de la anterior en vez de dejar dos filas contradictorias.
   */
  async addUserResponsibility(
    userId: string,
    input: { responsibility_key?: string; accion?: string; nota?: string; valid_from?: string; valid_to?: string | null },
    requester: OrgRequester,
  ) {
    const tenantId = this.tenantId;

    const user = await this.knex('identity.users')
      .where({ tenant_id: tenantId, id: userId })
      .whereNull('deleted_at')
      .first('id', 'username', 'kind');
    if (!user) throw new NotFoundException('El usuario no existe.');

    // ⛔ El trabajo se le reparte a personas. `[ID.31]` creó `kind='dispositivo'`
    // justamente para poder excluir kioscos y etiqueteras del reparto.
    if (user.kind !== 'interno') {
      throw new BadRequestException(
        `"${user.username}" es una cuenta de tipo "${user.kind}", no una persona: no puede responder de nada.`,
      );
    }

    const key = (input.responsibility_key ?? '').trim();
    const resp = await this.knex('identity.responsibilities').where({ key }).first('key', 'label');
    if (!resp) throw new BadRequestException(`La responsabilidad "${key}" no está en el catálogo.`);

    const accion = (input.accion ?? 'suma').trim();
    if (!ACCIONES.has(accion)) {
      throw new BadRequestException(`La acción tiene que ser "suma" o "resta" (llegó "${accion}").`);
    }

    const nota = (input.nota ?? '').trim();
    if (!nota) {
      throw new BadRequestException(
        'Falta el motivo. Una responsabilidad asignada a una persona y no a su puesto necesita decir ' +
          'por qué: sin eso, en seis meses nadie sabe si fue una decisión o un descuido.',
      );
    }

    if (input.valid_to && input.valid_from && input.valid_to < input.valid_from) {
      throw new BadRequestException('La vigencia termina antes de empezar.');
    }

    const previas = await this.knex('identity.user_responsibilities')
      .where({ tenant_id: tenantId, user_id: userId, responsibility_key: key })
      .whereNull('deleted_at')
      .select('id');

    await this.knex.transaction(async (trx) => {
      if (previas.length) {
        await trx('identity.user_responsibilities')
          .whereIn(
            'id',
            previas.map((p) => p.id),
          )
          .update({ deleted_at: trx.fn.now(), deleted_by: requester.sub });
      }

      await trx('identity.user_responsibilities').insert({
        tenant_id: tenantId,
        user_id: userId,
        responsibility_key: key,
        accion,
        nota,
        valid_from: input.valid_from ?? trx.raw('CURRENT_DATE'),
        valid_to: input.valid_to ?? null,
        created_by: requester.sub,
        updated_by: requester.sub,
      });

      await this.recordEvent(
        trx,
        userId,
        'responsabilidad_asignada',
        {
          responsibility_key: key,
          label: resp.label,
          accion,
          nota,
          valid_from: input.valid_from ?? null,
          valid_to: input.valid_to ?? null,
          reemplazo: previas.length,
        },
        requester,
      );
    });

    return this.userResponsibilities(userId);
  }

  async removeUserResponsibility(userId: string, id: string, requester: OrgRequester) {
    const tenantId = this.tenantId;
    const fila = await this.knex('identity.user_responsibilities')
      .where({ tenant_id: tenantId, id, user_id: userId })
      .whereNull('deleted_at')
      .first('id', 'responsibility_key', 'accion');
    if (!fila) throw new NotFoundException('Esa excepción no existe o ya se retiró.');

    await this.knex('identity.user_responsibilities')
      .where({ id })
      .update({ deleted_at: this.knex.fn.now(), deleted_by: requester.sub });

    await this.recordEvent(
      this.knex,
      userId,
      'responsabilidad_retirada',
      { responsibility_key: fila.responsibility_key, accion: fila.accion },
      requester,
    );
    return this.userResponsibilities(userId);
  }

  // ══ HISTORIA Y COHERENCIA ═════════════════════════════════════════════════

  /**
   * `identity.v_position_history` — persona × puesto × desde/hasta.
   *
   * Es una VISTA derivada, no una tabla: el proyecto deriva en vez de
   * materializar dos veces lo mismo. Sin esto sólo se puede contestar *¿quién
   * responde hoy?*, nunca *¿quién respondía en marzo?*
   *
   * ⚠️ `desde_origen` dice de dónde salió la fecha, y hay que mostrarlo:
   * `cambio` es un cambio observado de verdad · `registro_sistema` es cuándo se
   * creó la cuenta · `estimado_alta` es una estimación. Pintarlos igual sería
   * dar por medido lo que está estimado.
   */
  async positionHistory(userId: string) {
    const rows = await this.knex('identity.v_position_history')
      .where({ tenant_id: this.tenantId, user_id: userId })
      .orderBy([
        { column: 'desde', order: 'desc' },
        { column: 'registrado_at', order: 'desc' },
      ])
      .select(
        'position_code',
        'department_code',
        'desde',
        'hasta',
        'vigente',
        'desde_origen',
        'motivo',
        'actor_username',
        'registrado_at',
      );
    return { user_id: userId, tramos: rows };
  }

  /**
   * Los desacuerdos entre los tres ejes. Las dos vistas ya traen la columna
   * `dice` con la frase en castellano, así que la pantalla no reescribe el
   * diagnóstico — lo muestra.
   *
   * ⚠️ Están en vistas separadas a propósito: recrear la de `[OR.7.1]` con
   * `CREATE OR REPLACE` arriesgaba perderle el `security_invoker`, que es un
   * gotcha vivo del repo.
   */
  async coherencia() {
    const tenantId = this.tenantId;
    const [authz, resp] = await Promise.all([
      this.knex('identity.v_authz_coherencia').where({ tenant_id: tenantId }).select('*'),
      this.knex('identity.v_authz_coherencia_resp').where({ tenant_id: tenantId }).select('*'),
    ]);
    const filas = [...authz, ...resp];
    return {
      total: filas.length,
      por_tipo: filas.reduce((acc: Record<string, number>, f: { tipo: string }) => {
        acc[f.tipo] = (acc[f.tipo] ?? 0) + 1;
        return acc;
      }, {}),
      filas,
      medido_at: new Date().toISOString(),
    };
  }
}
