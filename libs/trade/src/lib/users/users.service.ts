import {
  BadRequestException,
  Logger,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { adaptadorDe, type MeContext, type MePendiente, type MeTarea, type MeWork } from '@megadulces/contracts';
import { BANDEJAS, puedeVerBandeja, type MedirCtx } from './me-work';
import { FUENTES_VISIBLES, puedeAbrirTarea } from './me-tasks';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import {
  getDataScope,
  TenantContextService,
  PermissionsCacheService,
  ScopeService,
  Permission,
  branchKeySql,
  branchKeyFilterSql,
} from '@megadulces/platform-core';

interface RequesterContext {
  sub: string;
  /** Se asienta en la bitácora: un uuid solo no dice quién fue. */
  username?: string;
  /**
   * Mapa de permisos que el guard relee del cache en cada request. Es la fuente de
   * `alcanceDelPadron()`, que acota el padrón a own / team / all.
   *
   * Antes acá decía `rules?: unknown[]` (las reglas de CASL serializadas en el JWT). Cuando CASL se
   * retiró, `getDataScope` pasó a leer `permissions` y este tipo quedó declarando un campo muerto y
   * ocultando el que de verdad se usa. Funcionaba porque en runtime llega el `req.user` completo,
   * pero nada impedía que un caller armara `{ sub, username }` y el alcance cayera en silencio a
   * `own` — el mismo trago amargo que el `if (payload.rules)` de vendor/portal.
   */
  permissions?: Record<string, boolean> | null;
  /** Rol del que depende el god-mode de plataforma (`isPlatformAdminRole`). */
  role_name?: string;
}

const ELEVATED_ROLES = new Set(['superadmin', 'admin']);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    // `[ID.13]` Optional: el cache vive en platform-core y este service se
    // instancia en tests sin él. Sin cache el complemento tarda el TTL (30s)
    // en verse; con cache se ve al instante.
    @Optional() private readonly permsCache?: PermissionsCacheService,
    // `[AUTHZ-HARD.0]` Para invalidar el cache de alcance (TTL 30s) al cambiar un scope, igual
    // que permsCache para permisos. Optional: los tests instancian el service sin él.
    @Optional() private readonly scopeService?: ScopeService,
  ) {}

  /**
   * Tenant del request. TODAS las queries de este service lo necesitan
   * EXPLÍCITO: `KNEX_CONNECTION` conecta como superusuario de Postgres, y un
   * superusuario bypassea RLS incluso con FORCE ROW LEVEL SECURITY. Sin el
   * filtro, este service veía y escribía el padrón de todos los tenants.
   */
  private get tenantId(): string {
    return this.tenantCtx.requireTenantId();
  }

  /**
   * `[ID.27]` Alcance del PADRÓN. No es `getDataScope()` a secas, y la diferencia
   * es un bug medido en prod, no una preferencia de estilo.
   *
   * `getDataScope()` resuelve el eje jerárquico de **REPORTES**: mira
   * `REPORTES_VER_GLOBAL` / `REPORTES_VER_EQUIPO`. El padrón de usuarios lo venía
   * usando tal cual, así que **quién ve la lista de personas dependía de sus
   * permisos de reporte**, no de sus permisos de usuarios. Consecuencia con
   * nombre y apellido:
   *
   *   · `recursos_humanos` (el rol de `[IDG.8]`) tiene `USUARIOS_GESTIONAR` y
   *     **ningún** permiso de reporte → caía en `own` → quien lo tuviera abriría
   *     `/admin/usuarios` y vería **una sola fila: la suya**. Un rol creado para
   *     administrar 126 cuentas que no podía ver ninguna.
   *   · `encargado_tienda` (**6 personas reales**, todas con sesión iniciada)
   *     tiene `USUARIOS_VER` sin permisos de reporte → mismo `own` → misma fila
   *     única. Esto es anterior al rol de RH: el patrón ya estaba ahí.
   *
   * La regla acá agrega **una** cláusula y no quita ninguna: quien administra
   * personal ve el padrón. Radio de impacto medido antes de escribirla:
   * `USUARIOS_GESTIONAR` lo conceden hoy exactamente 2 roles — `superadmin` (que
   * ya sale por god-mode) y `recursos_humanos` (0 personas asignadas). O sea que
   * **hoy no le cambia el alcance a ningún usuario vivo**; lo que hace es que el
   * rol de RH sirva cuando alguien lo reciba.
   *
   * ⚠️ Lo que esto NO arregla, y queda declarado en vez de resuelto a escondidas:
   * los 6 `encargado_tienda` veían 1 fila. `[ID.35]` lo resuelve con un cuarto
   * estado, `sucursal` — ver abajo.
   */
  private alcanceDelPadron(requester: RequesterContext): {
    type: 'own' | 'team' | 'all' | 'sucursal';
    userId: string;
  } {
    // Administrar personal exige verlo. Se evalúa ANTES de delegar en el eje de
    // reportes para que un rol de RH no dependa de tener permisos de reporte.
    if (requester.permissions?.[Permission.USUARIOS_GESTIONAR] === true) {
      return { type: 'all', userId: requester.sub };
    }

    const porReportes = getDataScope(requester);

    /**
     * `[ID.35]` — Cuarto estado: **el personal de mi sucursal**.
     *
     * Quien puede VER el padrón pero no administrarlo ni ver reportes caía en
     * `own` y abría `/admin/usuarios` para encontrar **una sola fila: la suya**.
     * Le pasaba a los 6 `encargado_tienda`, todos con sesión iniciada. Un
     * permiso que abre una pantalla vacía es peor que no tenerlo: parece un bug
     * del sistema, no una decisión de acceso.
     *
     * El eje correcto no es este de tres estados —que mira la jerarquía de
     * reportes— sino la dimensión `warehouse` de `ScopeService`, que es la que
     * ya gobierna qué sucursal le toca a cada quien (viva, 26 call sites).
     * Medido antes de escribirlo: `encargado_tienda` resuelve `warehouse: own`
     * sin overrides, así que cada uno pasa a ver entre 6 y 13 personas — el
     * personal de su tienda, incluida su etiquetera. Las 82 cuentas sin
     * sucursal (oficina, rutas) siguen fuera, que es lo correcto.
     *
     * ⚠️ Ensancha acceso a 6 personas reales: es decisión del lead, tomada el
     * 2026-09-10, no un efecto colateral.
     */
    if (porReportes.type === 'own' && requester.permissions?.[Permission.USUARIOS_VER] === true) {
      return { type: 'sucursal', userId: requester.sub };
    }

    // Todo lo demás conserva exactamente el comportamiento vigente, god-mode
    // incluido: `getDataScope` ya resuelve `isPlatformAdminRole` primero.
    return porReportes;
  }

  /**
   * `[ID.35]` Acota el padrón a la sucursal del que pregunta, **sin poder
   * dejarlo en cero**.
   *
   * El `OR u.id = <él mismo>` no es cortesía: `ScopeService.applyTo` emite
   * `WHERE false` cuando el modo es `own` y la ficha no tiene sucursal, y ahí la
   * pantalla quedaría **más vacía que antes** — ni siquiera su propia fila. Es
   * exactamente el fail-open silencioso que `[ID.26]` vino a hacer visible, y no
   * se reintroduce por la puerta de al lado.
   */
  private async acotarPorSucursal(
    query: Knex.QueryBuilder,
    requesterId: string,
  ): Promise<Knex.QueryBuilder> {
    // Sin `ScopeService` (los tests instancian el service sin él) se cae al
    // comportamiento anterior: sólo su fila. Fail-closed, nunca "ve todo".
    if (!this.scopeService) return query.where('u.id', requesterId);
    const scope = await this.scopeService.forUser(this.tenantId, requesterId);
    return query.where((qb: Knex.QueryBuilder) => {
      this.scopeService!.applyTo(qb, scope, 'warehouse', 'u.warehouse_code');
      qb.orWhere('u.id', requesterId);
    });
  }

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const zone = await this.knex('zones')
      .where({ name: zonaName, tenant_id: this.tenantId })
      .select('id')
      .first();
    return zone ? zone.id : null;
  }

  /**
   * `[ID.7]` — La zona llega por tres nombres y hay que quedarse con uno.
   *
   * `zone_id` es el canónico; `zona_id` y `zona` son alias deprecados que se
   * siguen aceptando para no romper al frontend actual. La precedencia es
   * explícita (uuid canónico → uuid viejo → nombre resuelto) en vez de quedar
   * al azar del orden de las propiedades del body.
   *
   * Devuelve `undefined` cuando NINGUNO vino, para poder distinguir en el
   * update "no lo mandes" de "ponelo en null" (desasignar zona).
   */
  private async resolveZoneRef(dto: {
    zone_id?: string;
    zona_id?: string;
    zona?: string;
  }): Promise<string | null | undefined> {
    if (dto.zone_id) return dto.zone_id;
    if (dto.zona_id) return dto.zona_id;
    if (dto.zona !== undefined) return this.resolveZonaId(dto.zona);
    return undefined;
  }

  /**
   * `[ID.24]` — La zona se DERIVA, no se pregunta.
   *
   * Las dos derivaciones están verificadas contra la data, no supuestas:
   *   - **ruta → zona**: de las 15 rutas con tiendas cargadas, **ninguna cruza
   *     de zona**. Es una función.
   *   - **sucursal → zona**: `commercial.warehouses.zone_id` (`[ID.23]`).
   *
   * Precedencia: la ruta gana. Para el vendedor de ruta vecinal parado en la
   * sucursal 02, su zona es su territorio (`LA PIEDAD VECINAL`), no la plaza de
   * la tienda donde está — y ese es justo el caso que se perdía al derivar de la
   * sucursal.
   *
   * Devuelve `undefined` cuando NO se puede derivar (ruta sin tiendas cargadas,
   * sucursal sin plaza, persona de oficinas). `undefined` significa **no toques
   * lo que ya tiene**: una zona en blanco es peor que una zona vieja, porque
   * `zone: own` la usa para filtrar y dejaría a la persona sin ver nada.
   */
  private async derivarZona(
    routeId?: string | null,
    warehouseCode?: string | null,
  ): Promise<string | undefined> {
    if (routeId) {
      const r = await this.knex('trade.stores')
        .where({ tenant_id: this.tenantId, ruta_id: routeId })
        .whereNull('deleted_at')
        .whereNotNull('zona_id')
        .select('zona_id')
        .first();
      if (r?.zona_id) return r.zona_id;
    }
    if (warehouseCode) {
      const w = await this.knex('commercial.warehouses')
        .where({ tenant_id: this.tenantId, code: warehouseCode })
        .whereNull('deleted_at')
        .select('zone_id')
        .first();
      if (w?.zone_id) return w.zone_id;
    }
    return undefined;
  }

  /**
   * `[ID.8]` — Asienta un cambio en `identity.user_events`.
   *
   * Es append-only y **nunca hace fallar la operación**: si la bitácora se cae,
   * el alta o el cambio de rol ya se hizo, y perder el asiento es mucho menos
   * grave que dejar la operación a medias. El error se loguea, no se propaga.
   *
   * Se le pasa la trx cuando hay una abierta, para que el asiento viva o muera
   * con la operación que describe.
   */
  private async recordEvent(
    trx: Knex | Knex.Transaction,
    userId: string,
    event: string,
    detalle: Record<string, unknown>,
    requester: RequesterContext,
  ): Promise<void> {
    try {
      await trx('identity.user_events').insert({
        tenant_id: this.tenantId,
        user_id: userId,
        event,
        detalle: JSON.stringify(detalle),
        actor_user_id: requester.sub ?? null,
        actor_username: requester.username ?? null,
      });
    } catch (e) {
      this.logger.warn(
        `No se pudo asentar el evento "${event}" del usuario ${userId}: ${(e as Error).message}`,
      );
    }
  }

  /** Nombre de la zona a partir del uuid, para las respuestas de escritura. */
  private async zoneNameOf(zonaId?: string | null): Promise<string | null> {
    if (!zonaId) return null;
    const z = await this.knex('zones')
      .where({ id: zonaId, tenant_id: this.tenantId })
      .select('name')
      .first();
    return z?.name ?? null;
  }

  private normalizeUsername(username: string): string {
    return username.toLowerCase().trim();
  }

  /**
   * Anti-escalation: solo un superadmin puede otorgar roles elevados
   * (superadmin/admin). Cualquier intento de elevar a alguien desde un rol
   * no-superadmin es rechazado.
   */
  private async assertCanAssignRole(
    targetRole: string,
    requester: RequesterContext,
  ): Promise<void> {
    const normalized = targetRole.toLowerCase();
    if (!ELEVATED_ROLES.has(normalized)) return;

    const requesterRow = await this.knex('users')
      .where({ id: requester.sub, tenant_id: this.tenantId })
      .select('role_name')
      .first();
    const requesterRole = (requesterRow?.role_name ?? '').toLowerCase();
    if (requesterRole !== 'superadmin') {
      throw new ForbiddenException(
        `Solo un superadmin puede asignar el rol "${normalized}".`,
      );
    }
  }

  /**
   * `[CH.1.10]` — Quién puede emitir una SESIÓN LARGA (cuenta de dispositivo).
   *
   * `USUARIOS_GESTIONAR` está diseñado para que RH dé de alta personas: en
   * `role-presets.ts` el grupo `usuarios` es primario de `rh`. Emitir una
   * credencial que vive un año es otra cosa, así que se restringe con el MISMO
   * mecanismo anti-escalada que ya usa este archivo para los roles elevados
   * (`assertCanAssignRole`): lo hace un superadmin.
   *
   * Se eligió reusar el mecanismo existente en vez de estrenar un permiso
   * `USUARIOS_TOKEN_DISPOSITIVO`. Un permiso nuevo son 4 touch-points + su
   * reparto en prod, y uno declarado pero NO repartido es exactamente la deuda
   * de la lección LC.6.2 (un módulo entero en prod que nadie podía abrir). El
   * permiso dedicado es el estado final deseable — el día que RH tenga que
   * hacerlo sin un superadmin a mano — y queda anotado en el tracker, no
   * implementado a medias.
   *
   * Sólo mira lo que el request PIDE: quitar el TTL (mandar `null`) no requiere
   * ser superadmin. Bajar privilegio nunca se gatea igual que subirlo.
   */
  private async assertCanSetDeviceSession(
    ttlPedido: number | null | undefined,
    requester: RequesterContext,
  ): Promise<void> {
    if (ttlPedido == null) return;

    const requesterRow = await this.knex('users')
      .where({ id: requester.sub, tenant_id: this.tenantId })
      .select('role_name')
      .first();
    if ((requesterRow?.role_name ?? '').toLowerCase() !== 'superadmin') {
      throw new ForbiddenException(
        'Sólo un superadmin puede emitir una sesión de dispositivo (un token que vive más de las 12 h del default).',
      );
    }
  }

  /**
   * `[CH.1.10]` — Una contraseña que nadie está obligado a cambiar sólo se
   * justifica en una pantalla desatendida.
   *
   * `[ID.8]` puso `must_change_password` en `true` para toda alta, y por una
   * razón: la contraseña la eligió OTRO (el admin), así que el dueño tiene que
   * cambiarla. Un kiosco es la excepción real — si se forzara el cambio, la
   * primera persona que pasa la cambia y la pantalla queda afuera (ya pasó:
   * `20260908150000_etiqueteras_no_forzar_cambio.js`).
   *
   * La regla, entonces: `false` se acepta **sólo si la cuenta declara su
   * duración de sesión**, o sea sólo si es un dispositivo.
   *
   * ── Se evalúa el CAMBIO, no la fila resultante ─────────────────────────────
   * Es la diferencia entre una compuerta y un bloqueo de trabajo ajeno. Las 7
   * cuentas `etiquetas.NN` que ya existen son `must_change_password = false` con
   * `token_ttl_days = null` — no porque alguien lo decidiera, sino porque su
   * script es anterior a la columna. Si esto mirara la fila resultante,
   * editarle el NOMBRE a una etiquetera se rechazaría, sin que el request haya
   * mencionado ninguno de los dos campos. Así que sólo se rechaza el movimiento
   * HACIA la combinación prohibida; lo que ya estaba queda editable.
   *
   * Y rechaza, no voltea en silencio: este repo ya pagó el precio de un default
   * silencioso (`{}` vs `{ expiresIn: undefined }` en `token-ttl.ts`).
   */
  private assertDeviceCredential(
    body: { must_change_password?: boolean; token_ttl_days?: number | null },
    actual?: { must_change_password?: boolean; token_ttl_days?: number | null },
  ): void {
    const pideForzarNo = body.must_change_password === false;
    const pideQuitarTtl = 'token_ttl_days' in body && body.token_ttl_days == null;
    if (!pideForzarNo && !pideQuitarTtl) return;

    const ttlResultante =
      'token_ttl_days' in body ? body.token_ttl_days : (actual?.token_ttl_days ?? null);
    const forzarResultante =
      body.must_change_password !== undefined
        ? body.must_change_password
        : (actual?.must_change_password ?? true);

    if (pideForzarNo && ttlResultante == null) {
      throw new BadRequestException(
        'Una cuenta que no fuerza el cambio de contraseña es una credencial de dispositivo: declará su duración de sesión (token_ttl_days). Si es una persona, la contraseña la eligió el admin y el dueño tiene que cambiarla.',
      );
    }
    if (pideQuitarTtl && forzarResultante === false) {
      throw new BadRequestException(
        'No se puede quitar la sesión larga sin devolver el cambio de contraseña forzado: quedaría una contraseña que nadie eligió y que nadie está obligado a cambiar. Mandá must_change_password: true en el mismo request.',
      );
    }
  }

  /**
   * Bloquea el caso de dejar al sistema sin ningún superadmin activo.
   * Se invoca antes de degradar de rol o desactivar.
   */
  private async assertNotLastSuperadmin(
    userId: string,
    nextActive: boolean,
    nextRole: string | undefined,
  ): Promise<void> {
    const current = await this.knex('users')
      .where({ id: userId, tenant_id: this.tenantId })
      .select('role_name', 'activo')
      .first();
    if (!current) return;

    const wasSuperadmin =
      (current.role_name ?? '').toLowerCase() === 'superadmin' &&
      current.activo === true;
    if (!wasSuperadmin) return;

    const willStaySuperadmin =
      nextActive !== false &&
      (nextRole === undefined ||
        nextRole.toLowerCase() === 'superadmin');
    if (willStaySuperadmin) return;

    // El cambio degradaría/desactivaría a un superadmin. Verificar que
    // queda al menos otro superadmin activo.
    const otherActive = await this.knex('users')
      .where({ role_name: 'superadmin', activo: true, tenant_id: this.tenantId })
      .andWhereNot({ id: userId })
      .count<{ count: string }>('id as count')
      .first();
    const otherCount = Number(otherActive?.count ?? 0);
    if (otherCount === 0) {
      throw new BadRequestException(
        'No puedes desactivar o degradar al último superadmin activo del sistema.',
      );
    }
  }

  /**
   * Valida los códigos de catálogo del usuario contra la DB ANTES de escribir.
   * Sin esto la FK compuesta tira 23503 y el handler lo convierte en un 500: el
   * admin veía "Error al actualizar usuario" sin motivo y quedaba un error de
   * servidor en el log por un dato de entrada inválido.
   *
   * `warehouse_code` se sumó acá y se le quitó el `@Matches(/^[0-9]{2}$/)` del
   * DTO: el regex validaba FORMA, no EXISTENCIA — aceptaba `'99'` feliz. Con el
   * default de alcance en `own` desde `[ID.3]`, una sucursal mal escrita ya no
   * es cosmética: deja al usuario sin ver nada y sin pista de por qué.
   */
  private async assertOrgCodes(
    departmentCode?: string | null,
    positionCode?: string | null,
    warehouseCode?: string | null,
    routeId?: string | null,
  ): Promise<void> {
    // `[ID.24.1]` La FK de `users.route_id` apunta a `trade.catalogs`, que guarda
    // TODOS los catálogos: la FK sola aceptaría un concepto o una ubicación como
    // "ruta". Que sea del catálogo de rutas no se expresa en una FK, así que se
    // valida acá — mismo motivo por el que `warehouse_code` dejó de confiar en
    // un regex de forma.
    if (routeId) {
      const ruta = await this.knex('trade.catalogs')
        .where({ tenant_id: this.tenantId, id: routeId, catalog_id: 'rutas' })
        .whereNull('deleted_at')
        .select('id')
        .first();
      if (!ruta) {
        throw new BadRequestException('La ruta seleccionada no existe en el catálogo de rutas.');
      }
    }
    if (warehouseCode) {
      // `[RE.27]` Se valida contra la MISMA llave canónica que ofrece `getBranches()`,
      // no contra `code` pelado. Antes el formulario ofrecía `30` (Morelia, RE.23) y
      // este chequeo lo rebotaba con 400, porque en el catálogo esa fila se llama
      // `MD-30`: el alta ofrecía una sucursal que ella misma no aceptaba, y las 319
      // recepciones mensuales de Morelia se quedaron sin nadie que pudiera subirlas.
      //
      // El modo silencioso era peor. Escribiendo `MD-30` a mano sí pasaba —y sigue
      // sin pasar, a propósito: `branchKeyFilterSql` sólo admite llaves de 2 dígitos—
      // porque entonces el alcance `own` resolvía a `['MD-30']`, el
      // `WHERE c.sucursal IN ('MD-30')` daba cero filas, y la persona veía la pantalla
      // vacía, que se lee igual que "no hay entradas".
      const wh = await this.knex('commercial.warehouses as w')
        .where({ 'w.tenant_id': this.tenantId })
        .whereNull('w.deleted_at')
        .whereRaw(branchKeyFilterSql('w'))
        .whereRaw(`(${branchKeySql('w')}) = ?`, [warehouseCode])
        .select('w.code')
        .first();
      if (!wh) {
        throw new BadRequestException(
          `La sucursal "${warehouseCode}" no existe en el catálogo de almacenes.`,
        );
      }
    }
    if (departmentCode) {
      const dep = await this.knex('identity.departments')
        .where({ tenant_id: this.tenantId, code: departmentCode })
        .whereNull('deleted_at')
        .select('code')
        .first();
      if (!dep) {
        throw new BadRequestException(
          `El departamento "${departmentCode}" no existe.`,
        );
      }
    }
    if (positionCode) {
      const pos = await this.knex('identity.positions')
        .where({ tenant_id: this.tenantId, code: positionCode })
        .whereNull('deleted_at')
        .select('code')
        .first();
      if (!pos) {
        throw new BadRequestException(`El puesto "${positionCode}" no existe.`);
      }
    }
  }

  /**
   * `[OR.2]` — ¿El perfil elegido se aparta del que propone el puesto?
   *
   * El puesto propone un `default_role` desde `[ID.15]` y el formulario ya
   * mostraba el select cuando el valor divergía — «una decisión que alguien tomó
   * y hay que poder ver». Lo que faltaba era **el porqué**: medido en prod, 14
   * de 100 personas llevan un rol distinto al que su puesto propone y no hay un
   * solo renglón que diga si fue decisión o descuido. 13 de esas 14 son el mismo
   * caso (`vendedor_ruta` con perfil `promotor_ruta`).
   *
   * Devuelve `null` cuando no hay divergencia, cuando el puesto no propone nada
   * (20 puestos siguen con `default_role` NULL) o cuando no hay puesto.
   */
  private async detectarDesvio(
    positionCode: string | null | undefined,
    roleName: string | null | undefined,
  ): Promise<{ position_code: string; propone: string; elegido: string } | null> {
    if (!positionCode || !roleName) return null;
    const pos = await this.knex('identity.positions')
      .where({ tenant_id: this.tenantId, code: positionCode })
      .whereNull('deleted_at')
      .first('code', 'default_role');
    if (!pos?.default_role) return null;
    const elegido = roleName.toLowerCase();
    if (pos.default_role.toLowerCase() === elegido) return null;
    return { position_code: pos.code, propone: pos.default_role, elegido };
  }

  /**
   * `[OR.2]` — Apartarse del puesto se puede; hacerlo en silencio, no.
   *
   * ⚠️ **La regla se evalúa sobre el CAMBIO, no sobre el estado guardado**, igual
   * que `must_change_password`/`token_ttl_days`. Si no, el formulario —que hace
   * `PUT` con el payload completo— pediría un motivo cada vez que alguien edita
   * el teléfono de una de las 14 personas que ya divergen, por una decisión que
   * tomó otro hace meses. Acá sólo pide motivo quien **crea** la divergencia:
   * un alta divergente, o un cambio que mueve el rol o el puesto.
   */
  private exigirMotivo(
    desvio: { position_code: string; propone: string; elegido: string },
    motivo: string | null | undefined,
  ): void {
    if (motivo && motivo.trim()) return;
    throw new BadRequestException(
      `El puesto "${desvio.position_code}" propone el perfil "${desvio.propone}" y se eligió ` +
        `"${desvio.elegido}". Apartarse está permitido, pero hay que decir por qué: enviá ` +
        `"motivo_desvio".`,
    );
  }

  async create(createUserDto: CreateUserDto, requester: RequesterContext) {
    // `zone_id`/`zona_id`/`zona` salen del rest: los tres colapsan en una sola
    // columna y la precedencia la decide `resolveZoneRef`.
    const {
      password,
      zona: _zonaLegacy,
      zona_id: _zonaIdLegacy,
      zone_id: _zoneId,
      role_name,
      username,
      // `[OR.2]` Fuera del `rest`: NO es una columna de `identity.users`, viaja
      // al evento. Dejarlo pasar haría reventar el INSERT con "column does not exist".
      motivo_desvio,
      ...rest
    } = createUserDto;

    await this.assertCanAssignRole(role_name, requester);

    // `[OR.2]` En un alta, toda divergencia es una decisión que se toma AHORA.
    const desvio = await this.detectarDesvio(createUserDto.position_code, role_name);
    if (desvio) this.exigirMotivo(desvio, motivo_desvio);
    // `[CH.1.10]` Sin fila previa: en un alta el "resultante" es lo que trae el body.
    this.assertDeviceCredential(createUserDto);
    await this.assertCanSetDeviceSession(createUserDto.token_ttl_days, requester);
    await this.assertOrgCodes(
      createUserDto.department_code,
      createUserDto.position_code,
      createUserDto.warehouse_code,
      createUserDto.route_id,
    );

    const normalizedUsername = this.normalizeUsername(username);

    const existing = await this.knex('users')
      .where({ username: normalizedUsername, tenant_id: this.tenantId })
      .select('id')
      .first();
    if (existing) {
      throw new ConflictException(
        `El nombre de usuario "${normalizedUsername}" ya está en uso.`,
      );
    }

    const password_hash = await bcrypt.hash(password, 10);
    // `[ID.24]` La zona se deriva de la ruta o de la sucursal. Sólo se respeta la
    // que venga explícita cuando no hay de dónde derivarla — así el alta deja de
    // preguntar lo mismo dos veces y la zona no puede quedar en desacuerdo con
    // el lugar donde la persona trabaja.
    const zona_id =
      (await this.derivarZona(createUserDto.route_id, createUserDto.warehouse_code)) ??
      (await this.resolveZoneRef(createUserDto)) ??
      null;
    const normalizedRoleName = role_name.toLowerCase();

    const [user] = await this.knex('users')
      .insert({
        ...rest,
        tenant_id: this.tenantCtx.requireTenantId(),
        zona_id,
        password_hash,
        role_name: normalizedRoleName,
        username: normalizedUsername,
        updated_by: requester.sub,
        created_by: requester.sub,
        // `[ID.8]` La contraseña la eligió OTRO (el admin que da el alta), así
        // que el dueño tiene que cambiarla. `created_by` además deja de estar
        // vacío: en prod estaba en NULL para los 117 usuarios.
        password_changed_at: this.knex.fn.now(),
        // `[CH.1.10]` Sigue siendo `true` por default — deja de ser una CONSTANTE
        // y pasa a ser un default. `[ID.8]` no se debilita: el único camino a
        // `false` lo abre `assertDeviceCredential()`, que lo exige acompañado de
        // una duración de sesión. Mientras estuvo hardcodeado, dar de alta un
        // kiosco por el endpoint era imposible y por eso el alta terminó en un
        // script suelto haciendo INSERT directo.
        must_change_password: rest.must_change_password ?? true,
      })
      .returning([
        'id',
        'username',
        'nombre',
        'zona_id',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
        // `[CH.1.7]` La respuesta tiene que describir lo que quedó guardado. Sin
        // estos dos, el cliente manda un TTL, recibe 200 y no puede distinguir
        // "se guardó" de "se descartó en silencio" — que es exactamente lo que
        // hace `ValidationPipe({ whitelist: true })` con un campo no declarado.
        'token_ttl_days',
        'kind',
      ]);

    // `[CH.1.10]` Emitir una credencial de un año queda asentado. Es la mitad
    // que faltaba de "auditable": la otra es poder verlo en la pantalla, y sin
    // este renglón la única huella de quién la emitió sería el `created_by`.
    if (user?.token_ttl_days != null) {
      await this.recordEvent(
        this.knex,
        user.id,
        'device_session_granted',
        {
          token_ttl_days: user.token_ttl_days,
          must_change_password: rest.must_change_password ?? true,
          kind: user.kind ?? null,
          nota: 'credencial de pantalla desatendida: se revoca desactivando la cuenta, no esperando su vencimiento',
        },
        requester,
      );
    }

    // `[OR.2]` La divergencia con el puesto queda asentada CON su motivo. Antes
    // era visible en el formulario y no quedaba en ningún lado: las 14 personas
    // que hoy divergen no tienen un renglón que diga si fue decisión o descuido.
    if (desvio && user?.id) {
      await this.recordEvent(
        this.knex,
        user.id,
        'desvio_de_puesto',
        { ...desvio, motivo: (motivo_desvio ?? '').trim(), origen: 'alta' },
        requester,
      );
    }

    // El nombre de la zona se resuelve del uuid que quedó guardado: ya no hay
    // una variable `zona` en scope (los tres alias colapsaron en `[ID.7]`) y
    // devolver el que mandó el cliente sería devolverle su propio input.
    return { ...user, zona: await this.zoneNameOf(zona_id) };
  }

  async findAll(
    zona: string | undefined,
    activo: string | undefined,
    requester: RequesterContext,
  ) {
    const jsDay = new Date().getDay();
    const dow = jsDay === 0 ? 7 : jsDay;

    const knex = this.knex;
    const query = knex('users as u')
      .where('u.tenant_id', this.tenantId)
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('daily_assignments as da', function () {
        this.on('da.user_id', '=', 'u.id');
        this.on('da.day_of_week', '=', knex.raw('?', [dow]));
      })
      .leftJoin('catalogs as cr', function () {
        this.on('cr.id', '=', 'da.route_id');
        this.on('cr.catalog_id', '=', knex.raw("'rutas'"));
      })
      // Ejes organizacionales (Fase UN): el departamento y el puesto son dato
      // real de la fila, ya no se infieren del role_name en el frontend.
      .leftJoin('identity.departments as dp', function () {
        this.on('dp.tenant_id', '=', 'u.tenant_id');
        this.on('dp.code', '=', 'u.department_code');
      })
      .leftJoin('identity.positions as ps', function () {
        this.on('ps.tenant_id', '=', 'u.tenant_id');
        this.on('ps.code', '=', 'u.position_code');
      })
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'z.name as zona',
        'u.zona_id',
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.warehouse_code',
        // [ID.24.1] La ruta de la persona: su eje, si es de ruta.
        'u.route_id',
        'u.department_code',
        'dp.name as department_name',
        'u.position_code',
        'ps.name as position_name',
        'u.finance_expense_area_ids',
        'u.created_at',
        'u.last_login_at',
        'u.last_login_ip',
        // `[CH.1.7]` Cuánto vive el token de esta cuenta y de qué tipo es.
        // Se devuelven para que exista la lista auditable de "quién tiene token
        // largo": el TTL nació en `[CH.1.1]` y la capa que administra usuarios
        // no lo conocía, así que la única forma de verlo era un SELECT a mano.
        // Un permiso de un año que no se puede ver desde la pantalla tampoco se
        // puede revisar ni quitar.
        'u.token_ttl_days',
        'u.kind',
        knex.raw(
          'CASE WHEN da.id IS NOT NULL THEN true ELSE false END as has_route_today',
        ),
        'cr.value as route_name_today',
      );

    // Scope enforcement: quien administra personal (`USUARIOS_GESTIONAR`) o ve
    // reportes globales ve todo el padrón; `sucursal` ve al personal de su
    // tienda (`[ID.35]`); team-scope ve su equipo + sí mismo; own-scope sólo a
    // sí mismo. Ver `alcanceDelPadron` para por qué el eje de reportes no
    // alcanzaba — `[ID.27]`.
    const scope = this.alcanceDelPadron(requester);
    if (scope.type === 'team') {
      query.where((qb) => {
        qb.where('u.supervisor_id', requester.sub).orWhere(
          'u.id',
          requester.sub,
        );
      });
    } else if (scope.type === 'sucursal') {
      await this.acotarPorSucursal(query, requester.sub);
    } else if (scope.type === 'own') {
      query.where('u.id', requester.sub);
    }

    if (zona) query.where('z.name', zona);
    if (activo) query.where('u.activo', activo === 'true');
    return query;
  }

  async findOne(id: string, requester: RequesterContext) {
    const user = await this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('identity.departments as dp', function () {
        this.on('dp.tenant_id', '=', 'u.tenant_id');
        this.on('dp.code', '=', 'u.department_code');
      })
      .leftJoin('identity.positions as ps', function () {
        this.on('ps.tenant_id', '=', 'u.tenant_id');
        this.on('ps.code', '=', 'u.position_code');
      })
      .where('u.id', id)
      .where('u.tenant_id', this.tenantId)
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'z.name as zona',
        'u.zona_id',
        'u.role_name',
        'u.activo',
        'u.supervisor_id',
        'u.supervisor_id as parent_supervisor',
        'u.warehouse_code',
        // `[ID.24.1]` La ruta de la persona: su eje, si es de ruta.
        'u.route_id',
        'u.department_code',
        'dp.name as department_name',
        'u.position_code',
        'ps.name as position_name',
        'u.finance_expense_area_ids',
        'u.created_at',
        // `[CH.1.7]` Ver el detalle de una cuenta tiene que incluir cuánto vive
        // su token: es el atributo que decide si la credencial dura 12 h o un año.
        'u.token_ttl_days',
        'u.kind',
      )
      .first();

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    // Mismo eje que `findAll`: si la lista te muestra a alguien, el detalle no
    // puede negártelo — y al revés. `[ID.27]`
    const scope = this.alcanceDelPadron(requester);
    if (scope.type === 'team') {
      const isSelf = user.id === requester.sub;
      const isDirectReport = user.parent_supervisor === requester.sub;
      if (!isSelf && !isDirectReport) {
        throw new ForbiddenException(
          'No puedes ver usuarios fuera de tu equipo.',
        );
      }
    } else if (scope.type === 'sucursal') {
      // `[ID.35]` El detalle usa el MISMO criterio que la lista: la sucursal del
      // que pregunta, más su propia ficha. Si la lista te lo mostró, el detalle
      // no puede negártelo — y si no, tampoco puede dejarte entrar por la URL.
      const esUnoMismo = user.id === requester.sub;
      const puede =
        esUnoMismo ||
        (!!this.scopeService &&
          !!user.warehouse_code &&
          this.scopeService.canRead(
            await this.scopeService.forUser(this.tenantId, requester.sub),
            'warehouse',
            String(user.warehouse_code),
          ));
      if (!puede) {
        throw new ForbiddenException('No puedes ver usuarios de otra sucursal.');
      }
    } else if (scope.type === 'own' && user.id !== requester.sub) {
      throw new ForbiddenException('No puedes ver otros usuarios.');
    }

    return user;
  }

  async update(
    id: string,
    updateUserDto: UpdateUserDto,
    requester: RequesterContext,
  ) {
    // Los tres nombres de zona salen del rest (colapsan en una sola columna).
    const {
      password,
      zona: _zonaLegacy,
      zona_id: _zonaIdLegacy,
      zone_id: _zoneId,
      role_name,
      username,
      activo,
      // `[OR.2]` Fuera del `rest`: no es columna de `identity.users`, va al evento.
      motivo_desvio,
      ...rest
    } = updateUserDto;

    const isSelf = id === requester.sub;

    // Anti-self-elevation / self-lockout: nadie puede cambiarse su propio
    // rol ni desactivarse a sí mismo. Estos cambios solo proceden vía un
    // tercero con permisos suficientes.
    if (isSelf && role_name !== undefined) {
      throw new ForbiddenException(
        'No puedes modificar tu propio rol.',
      );
    }
    if (isSelf && activo === false) {
      throw new ForbiddenException(
        'No puedes desactivar tu propio usuario.',
      );
    }

    if (role_name !== undefined) {
      await this.assertCanAssignRole(role_name, requester);
    }

    // `[CH.1.10]` La compuerta de la credencial de dispositivo, también en la
    // edición. Sin esto la regla sería la mitad de una regla: hoy un PUT puede
    // poner `must_change_password: false` a cualquier persona y nadie lo mira.
    // Se lee la fila actual porque la regla se evalúa sobre el CAMBIO — un PUT
    // que no menciona ninguno de los dos campos no se toca (ver el método).
    if (
      updateUserDto.must_change_password !== undefined ||
      'token_ttl_days' in updateUserDto
    ) {
      const actual = await this.knex('users')
        .where({ id, tenant_id: this.tenantId })
        .select('must_change_password', 'token_ttl_days')
        .first();
      if (!actual) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
      this.assertDeviceCredential(updateUserDto, actual);
      await this.assertCanSetDeviceSession(updateUserDto.token_ttl_days, requester);
    }

    await this.assertOrgCodes(
      updateUserDto.department_code,
      updateUserDto.position_code,
      updateUserDto.warehouse_code,
      updateUserDto.route_id,
    );

    // `[OR.2]` Divergencia con el puesto. ⚠️ Se evalúa sobre el CAMBIO: el
    // formulario hace `PUT` con el payload completo, así que mirar el estado
    // guardado pediría motivo cada vez que alguien edita el teléfono de una de
    // las 14 personas que ya divergen, por una decisión que tomó otro hace
    // meses. Sólo se le pide a quien CREA la divergencia.
    let desvioUpd: { position_code: string; propone: string; elegido: string } | null = null;
    if (role_name !== undefined || 'position_code' in updateUserDto) {
      const actual = await this.knex('users')
        .where({ id, tenant_id: this.tenantId })
        .select('role_name', 'position_code')
        .first();
      if (!actual) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

      const rolFinal = role_name !== undefined ? role_name : actual.role_name;
      const puestoFinal =
        'position_code' in updateUserDto ? updateUserDto.position_code : actual.position_code;

      const cambiaRol =
        role_name !== undefined &&
        (role_name ?? '').toLowerCase() !== (actual.role_name ?? '').toLowerCase();
      const cambiaPuesto =
        'position_code' in updateUserDto &&
        (updateUserDto.position_code ?? null) !== (actual.position_code ?? null);

      if (cambiaRol || cambiaPuesto) {
        desvioUpd = await this.detectarDesvio(puestoFinal, rolFinal);
        if (desvioUpd) this.exigirMotivo(desvioUpd, motivo_desvio);
      }
    }

    // Defensa contra dejar al sistema sin superadmins activos.
    if (role_name !== undefined || activo !== undefined) {
      await this.assertNotLastSuperadmin(id, activo !== false, role_name);
    }

    const updateData: Record<string, unknown> = { ...rest };

    if (password) {
      updateData['password_hash'] = await bcrypt.hash(password, 10);
    }

    if (username) {
      const normalized = this.normalizeUsername(username);
      const conflict = await this.knex('users')
        .where({ username: normalized, tenant_id: this.tenantId })
        .andWhereNot({ id })
        .select('id')
        .first();
      if (conflict) {
        throw new ConflictException(
          `El nombre de usuario "${normalized}" ya está en uso.`,
        );
      }
      updateData['username'] = normalized;
    }

    // `undefined` = ninguno de los tres nombres vino → no se toca la columna.
    // `null` = vino `zona: ''` o un nombre que no existe → se desasigna. La
    // distinción importa: un PATCH que no menciona la zona no debe borrarla.
    const zoneRef = await this.resolveZoneRef(updateUserDto);
    if (zoneRef !== undefined) {
      updateData['zona_id'] = zoneRef;
    }

    // `[ID.24]` Si cambió la ruta o la sucursal, la zona se RE-DERIVA. Sin esto
    // se puede mover a alguien de plaza y dejarle la zona anterior, que es
    // exactamente la clase de desacuerdo silencioso que el eje vino a matar.
    // Sólo pisa cuando hay de dónde derivar, y nunca contra una zona que vino
    // explícita en el mismo request (ahí manda quien la escribió).
    if (zoneRef === undefined && (updateUserDto.route_id !== undefined || updateUserDto.warehouse_code !== undefined)) {
      const derivada = await this.derivarZona(
        updateUserDto.route_id,
        updateUserDto.warehouse_code,
      );
      if (derivada) updateData['zona_id'] = derivada;
    }

    if (role_name !== undefined) {
      updateData['role_name'] = role_name.toLowerCase();
    }

    if (activo !== undefined) {
      updateData['activo'] = activo;
    }

    updateData['updated_at'] = this.knex.fn.now();
    updateData['updated_by'] = requester.sub;

    const [user] = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .update(updateData)
      .returning([
        'id',
        'username',
        'nombre',
        'zona_id',
        'role_name',
        'activo',
        'supervisor_id',
        'created_at',
        // `[CH.1.7]` La respuesta tiene que describir lo que quedó guardado. Sin
        // estos dos, el cliente manda un TTL, recibe 200 y no puede distinguir
        // "se guardó" de "se descartó en silencio" — que es exactamente lo que
        // hace `ValidationPipe({ whitelist: true })` con un campo no declarado.
        'token_ttl_days',
        'kind',
      ]);

    if (!user) {
      throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
    }

    // `[CH.1.10]` Otorgar Y revocar una sesión larga quedan asentados. Revocar
    // importa igual que otorgar: es la operación que alguien va a querer
    // reconstruir el día que un kiosco "dejó de funcionar solo".
    if ('token_ttl_days' in updateUserDto) {
      await this.recordEvent(
        this.knex,
        id,
        user.token_ttl_days != null ? 'device_session_granted' : 'device_session_revoked',
        {
          token_ttl_days: user.token_ttl_days ?? null,
          must_change_password: updateUserDto.must_change_password,
          nota:
            user.token_ttl_days != null
              ? 'la nueva duración aplica al PRÓXIMO ingreso; no acorta el token ya emitido'
              : 'vuelve al default global (12 h) en su próximo ingreso; el token vigente sigue vivo hasta su exp',
        },
        requester,
      );
    }

    // `[OR.2]` Quien se apartó del puesto, cuándo y por qué.
    if (desvioUpd) {
      await this.recordEvent(
        this.knex,
        id,
        'desvio_de_puesto',
        { ...desvioUpd, motivo: (motivo_desvio ?? '').trim(), origen: 'edicion' },
        requester,
      );
    }

    return { ...user, zona: await this.zoneNameOf(user.zona_id) };
  }

  async remove(id: string, requester: RequesterContext) {
    if (requester.sub === id) {
      throw new ForbiddenException(
        'No puedes desactivar tu propio usuario.',
      );
    }

    await this.assertNotLastSuperadmin(id, false, undefined);

    return this.knex.transaction(async (trx) => {
      const count = await trx('users').where({ id, tenant_id: this.tenantId }).update({
        activo: false,
        deleted_at: trx.fn.now(),
        deleted_by: requester.sub,
        updated_at: trx.fn.now(),
        updated_by: requester.sub,
      });
      if (count === 0) {
        throw new NotFoundException(`Usuario con ID ${id} no encontrado`);
      }

      const orphans = await trx('users')
        .where({ supervisor_id: id, tenant_id: this.tenantId })
        .update({ supervisor_id: null });

      return {
        message: 'El usuario ha sido desactivado (soft delete)',
        orphans_cleared: orphans,
      };
    });
  }

  async getRoles() {
    // Filtro de tenant EXPLÍCITO: `KNEX_CONNECTION` conecta como superusuario, y
    // un superusuario bypassea RLS incluso con FORCE ROW LEVEL SECURITY. Sin
    // este WHERE el endpoint devolvía los roles de TODOS los tenants (verificado:
    // 47 filas para 30 roles reales).
    return this.knex('role_permissions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .select('role_name')
      .orderBy('role_name', 'asc');
  }

  async findSupervisors(zona?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where('u.role_name', 'like', '%supervisor%')
      .where({ 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona');

    if (zona) query.where('z.name', zona);
    return query;
  }

  async findSellers(zona?: string, supervisorId?: string) {
    const query = this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .whereNotIn('u.role_name', ['supervisor_v', 'admin', 'superadmin'])
      .where({ 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select(
        'u.id',
        'u.nombre',
        'u.username',
        'z.name as zona',
        'u.role_name',
        'u.supervisor_id',
      );

    if (zona) query.where('z.name', zona);
    if (supervisorId) query.where({ 'u.supervisor_id': supervisorId });

    return query;
  }

  async findBySupervisor(supervisorId: string) {
    return this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .where({ 'u.supervisor_id': supervisorId, 'u.activo': true, 'u.tenant_id': this.tenantId })
      .select('u.id', 'u.nombre', 'u.username', 'z.name as zona', 'u.role_name');
  }

  async getZones() {
    return this.knex('zones')
      .where({ tenant_id: this.tenantId })
      .orderBy('orden', 'asc')
      .select('id', 'name as value', 'orden');
  }

  /**
   * Catálogo de departamentos del organigrama (eje organizacional, Fase UN).
   * No confundir con los roles: el departamento describe dónde trabaja la
   * persona, el rol describe qué puede hacer en la app.
   */
  /**
   * `[ID.23]` — Sucursales con la ZONA que cada una declara.
   *
   * Existe para que el alta pregunte una sola vez: se elige la sucursal y la zona
   * se deriva de acá. Antes el formulario listaba las sucursales desde una
   * constante hardcodeada del front (`STORE_BRANCHES`), que además de no traer la
   * zona se desincroniza de la DB sin que nadie se entere.
   *
   * `zone_id` puede venir NULL: hay sucursales sin plaza definida (04 Yurécuaro)
   * y el formulario tiene que poder decirlo en vez de rellenar cualquier cosa.
   */
  async getBranches() {
    return this.knex('commercial.warehouses as w')
      .leftJoin('trade.zones as z', function () {
        this.on('z.tenant_id', '=', 'w.tenant_id').andOn('z.id', '=', 'w.zone_id');
      })
      .where({ 'w.tenant_id': this.tenantId })
      .whereNull('w.deleted_at')
      // `[RE.23]` La sucursal se identifica por su código de 2 dígitos, que en
      // Morelia NO vive en `code` (`MD-30`) sino en `wincaja_source_branch`.
      // Filtrar por `code` dejaba a Morelia fuera del alta: no había forma de
      // asignarle esas sucursales a nadie. Ver `branchKeySql` en platform-core.
      .whereRaw(branchKeyFilterSql('w'))
      .orderByRaw('1')
      .select(
        this.knex.raw(`${branchKeySql('w')} AS code`),
        'w.name',
        'w.zone_id',
        'z.name as zone_name',
      );
  }

  /**
   * `[ID.26]` — El estado del padrón, medido y con su cobertura declarada.
   *
   * ── Por qué existe ──────────────────────────────────────────────────────────
   * Las cifras que sostienen el rediseño de identidad se sacaron a mano contra
   * prod y vivían en un mensaje. Un número que no se puede volver a sacar no es
   * una medición. Esto las pone en una consulta versionada.
   *
   * ── El bloque que importa: la ceguera de alcance ────────────────────────────
   * `ScopeService.applyTo()` emite `WHERE false` cuando el modo es `none` **o**
   * cuando la lista de valores viene vacía. Y `valoresDe()` devuelve lista vacía
   * para `own` con la columna de la ficha en NULL. Consecuencia: **«no ve nada
   * porque así se configuró» y «no sabemos qué ve porque le falta el dato»
   * producen el mismo SQL y la misma pantalla en blanco.**
   *
   * Se mide contra `identity.user_scopes` → `role_scopes` con la misma
   * precedencia que el resolver (override de persona gana; sin fila, `none`), y
   * se reporta ANTES de cerrar nada — cerrar primero es la ceguera que esto
   * viene a denunciar.
   *
   * ── ADR-056 ─────────────────────────────────────────────────────────────────
   * Cada bloque viaja con `measured`. Sin universo que medir se reporta
   * `measured: false`, **nunca** «0 problemas»: un diagnóstico que se pone verde
   * en vacío es peor que no tenerlo, porque además da confianza.
   */
  async diagnosticoPadron() {
    const tenantId = this.tenantId;

    // Universo: las cuentas vivas del tenant. Si es 0, no se mide nada.
    const { rows: universo } = await this.knex.raw(
      `SELECT count(*)::int AS cuentas,
              count(*) FILTER (WHERE kind = 'interno')::int AS internas
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL`,
      [tenantId],
    );
    const cuentas = universo[0]?.cuentas ?? 0;
    if (!cuentas) {
      return {
        tenant_id: tenantId,
        medido_at: new Date().toISOString(),
        universo: { cuentas: 0, internas: 0 },
        ceguera_alcance: { measured: false, motivo: 'El tenant no tiene cuentas activas.' },
        ficha: { measured: false, motivo: 'El tenant no tiene cuentas activas.' },
        clases: { measured: false, motivo: 'El tenant no tiene cuentas activas.' },
        roles_inertes: { measured: false, motivo: 'El tenant no tiene cuentas activas.' },
      };
    }

    // ── Ceguera de alcance ────────────────────────────────────────────────────
    // La columna de la ficha por dimensión es la misma tabla que usa
    // `ScopeService.COLUMNA_PROPIA`. Las dimensiones sin columna (`brand`,
    // `expense_area`) no pueden resolver `own` por construccion: tambien cuentan.
    const { rows: ciegos } = await this.knex.raw(
      `WITH efectivo AS (
         SELECT u.id, u.username, u.role_name, d.code AS dimension,
                COALESCE(us.mode, rs.mode) AS mode,
                CASE d.code
                  WHEN 'warehouse' THEN u.warehouse_code
                  WHEN 'zone'      THEN u.zona_id::text
                  WHEN 'route'     THEN u.route_id::text
                  WHEN 'customer'  THEN u.customer_id::text
                  ELSE NULL
                END AS valor_ficha
           FROM identity.users u
           CROSS JOIN identity.scope_dimensions d
           LEFT JOIN identity.user_scopes us
             ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = d.code
           LEFT JOIN identity.role_scopes rs
             ON rs.tenant_id = u.tenant_id AND rs.role_name = u.role_name AND rs.dimension = d.code
          WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL)
       SELECT dimension, count(*)::int AS personas,
              string_agg(username, ', ' ORDER BY username) AS quienes
         FROM efectivo
        WHERE mode = 'own' AND valor_ficha IS NULL
        GROUP BY dimension ORDER BY 2 DESC`,
      [tenantId],
    );

    // ── Ficha incompleta ──────────────────────────────────────────────────────
    const { rows: ficha } = await this.knex.raw(
      `SELECT count(*)::int AS internas,
              count(*) FILTER (WHERE position_code   IS NULL)::int AS sin_puesto,
              count(*) FILTER (WHERE department_code IS NULL)::int AS sin_departamento,
              count(*) FILTER (WHERE warehouse_code  IS NULL)::int AS sin_sucursal,
              count(*) FILTER (WHERE zona_id         IS NULL)::int AS sin_zona,
              count(*) FILTER (WHERE supervisor_id   IS NULL)::int AS sin_supervisor,
              count(*) FILTER (WHERE last_login_at   IS NULL)::int AS nunca_entraron
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND kind = 'interno'`,
      [tenantId],
    );

    // ── Clases de cuenta ──────────────────────────────────────────────────────
    // Heurística DECLARADA, no verdad: un `nombre` de una sola palabra o igual
    // al username es una credencial de puesto, no una persona. Lo correcto es
    // que la cuenta lo declare (`[ID.28]`); hasta entonces esto se etiqueta como
    // estimado y por eso el campo se llama `estimado`.
    const { rows: clases } = await this.knex.raw(
      `SELECT CASE
                WHEN kind = 'servicio' THEN 'cuenta_de_servicio'
                WHEN role_name = 'customer_b2b' THEN 'no_empleado'
                WHEN upper(COALESCE(nombre, '')) = upper(username)
                  OR COALESCE(nombre, '') NOT LIKE '% %' THEN 'credencial_de_puesto'
                ELSE 'persona' END AS clase,
              count(*)::int AS cuentas
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL
        GROUP BY 1 ORDER BY 2 DESC`,
      [tenantId],
    );

    // ── Personas con más de una cuenta ────────────────────────────────────────
    const { rows: dobles } = await this.knex.raw(
      `SELECT lower(nombre) AS persona, count(*)::int AS cuentas,
              string_agg(username || ' [' || role_name || ']', ' + ' ORDER BY username) AS detalle
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL
          AND COALESCE(nombre, '') LIKE '% %'
        GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC`,
      [tenantId],
    );

    // ── Roles que conceden CERO y tienen gente activa ─────────────────────────
    const { rows: inertes } = await this.knex.raw(
      `SELECT rp.role_name, count(u.id)::int AS usuarios_activos,
              string_agg(u.username, ', ' ORDER BY u.username) AS quienes
         FROM identity.role_permissions rp
         JOIN identity.users u
           ON u.tenant_id = rp.tenant_id AND lower(u.role_name) = lower(rp.role_name)
          AND u.activo AND u.deleted_at IS NULL
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM jsonb_each(rp.permissions) e(k, v) WHERE v = 'true'::jsonb)
        GROUP BY rp.role_name ORDER BY 2 DESC`,
      [tenantId],
    );

    return {
      tenant_id: tenantId,
      medido_at: new Date().toISOString(),
      universo: universo[0],
      ceguera_alcance: {
        measured: true,
        personas: ciegos.reduce((a: number, r: any) => a + r.personas, 0),
        por_dimension: ciegos,
        nota:
          'mode = own con la columna de la ficha en NULL. Hoy produce el MISMO WHERE false que none, ' +
          'asi que en pantalla es indistinguible de "no ve nada". Cerrar el filtro es [ID.43], y va ' +
          'DESPUES de poblar la ficha.',
      },
      ficha: { measured: true, ...ficha[0] },
      clases: { measured: true, estimado: clases, personas_con_varias_cuentas: dobles },
      roles_inertes: { measured: true, roles: inertes },
    };
  }

  async getDepartments() {
    return this.knex('identity.departments')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .orderBy('orden', 'asc')
      // `[ID.24]` `scope_axis` viaja con el departamento: es el FALLBACK del eje
      // para los 77 usuarios sin puesto asignado (sólo 7 no tienen departamento).
      .select('code', 'name', 'orden', 'scope_axis');
  }

  /**
   * `[ID.24.1]` — Rutas con la zona que cada una implica.
   *
   * Alimenta el selector de ruta del alta para la gente de eje `ruta`. La zona
   * viene calculada acá y no en el front porque sale de las TIENDAS de la ruta
   * (no hay columna de zona en el catálogo de rutas), y eso es una query, no un
   * dato que el formulario deba saber armar.
   *
   * Devuelve también `tiendas`: una ruta con 0 tiendas no puede derivar zona, y
   * la pantalla tiene que poder decirlo en vez de dejar la zona en blanco sin
   * explicación. Hoy son 8 de 23.
   */
  async getRoutes() {
    const filas = await this.knex.raw(
      `SELECT c.id::text AS id,
              c.value AS name,
              count(s.id)::int AS tiendas,
              (array_agg(z.id::text ORDER BY z.name) FILTER (WHERE z.id IS NOT NULL))[1] AS zone_id,
              (array_agg(z.name  ORDER BY z.name) FILTER (WHERE z.id IS NOT NULL))[1] AS zone_name
         FROM trade.catalogs c
         LEFT JOIN trade.stores s
           ON s.tenant_id = c.tenant_id AND s.ruta_id = c.id AND s.deleted_at IS NULL
         LEFT JOIN trade.zones z
           ON z.tenant_id = s.tenant_id AND z.id = s.zona_id
        WHERE c.tenant_id = ? AND c.catalog_id = 'rutas' AND c.deleted_at IS NULL
        GROUP BY c.id, c.value, c.orden
        ORDER BY c.orden, c.value`,
      [this.tenantId],
    );
    return filas.rows;
  }

  /**
   * Catálogo plano de puestos canonicalizados del ORGANIGRAMA 2026.
   * `org_labels` trae las etiquetas literales del PDF que se colapsaron en cada
   * puesto — útil para que el admin reconozca el puesto por como se llama en el
   * organigrama impreso.
   */
  async getPositions() {
    return this.knex('identity.positions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .orderBy('orden', 'asc')
      // `[ID.15]` `department_code` y `default_role` viajan con el puesto: es lo
      // que permite que el alta PROPONGA en vez de pedirle al que da de alta que
      // adivine entre 28 roles. `default_role` puede venir NULL — hay 20 puestos
      // para los que todavía no existe un perfil que les quede.
      // `[ID.24]` `scope_axis` NULL = hereda del departamento. El front resuelve
      // `puesto → departamento` con las dos listas que ya carga.
      .select('code', 'name', 'org_labels', 'orden', 'department_code', 'default_role', 'scope_axis');
  }

  /**
   * `[ID.15]` — Lo que el sistema PROPONE para un puesto.
   *
   * El alta deja de ser "elegí un rol de esta lista larga" y pasa a ser
   * "persona + puesto + sucursal", con el departamento y el perfil ya sugeridos.
   * Ahí muere el crecimiento del catálogo: nadie inventa un rol para dar de alta
   * a alguien.
   */
  async proposeForPosition(positionCode: string) {
    const pos = await this.knex('identity.positions')
      .where({ tenant_id: this.tenantId, code: positionCode })
      .whereNull('deleted_at')
      .first(
        'code',
        'name',
        'department_code',
        'default_role',
        'scope_axis',
        // `[OR.1a]` El jefe del PUESTO. Es la cuarta cosa que el puesto propone.
        'reports_to_position_code',
        // `[OR.7.0b]` El perfil puede ser COMPUESTO. Nació de medir que las 3
        // personas de `auxiliar_administrativo` tienen las 3 el complemento
        // `analisis_ventas`: eso no es una excepción, es el perfil del puesto.
        'default_complements',
      );
    if (!pos) throw new NotFoundException(`El puesto "${positionCode}" no existe`);

    const dept = pos.department_code
      ? await this.knex('identity.departments')
          .where({ tenant_id: this.tenantId, code: pos.department_code })
          .first('code', 'name', 'scope_axis')
      : null;

    // El alcance por default NO sale del puesto: vive en `identity.role_scopes`
    // (por rol, desde `[ID.3]`). Se devuelve para que la pantalla lo muestre,
    // pero la fuente sigue siendo una sola.
    const alcance = pos.default_role
      ? await this.knex('identity.role_scopes')
          .where({ tenant_id: this.tenantId, role_name: pos.default_role })
          .orderBy('dimension')
          .select('dimension', 'mode', 'values', 'mode_write')
      : [];

    // `[OR.1a]` El JEFE sale del PUESTO, no de la persona. `supervisor_id` quedó
    // como excepción. Se devuelve también QUIÉN ocupa hoy ese puesto: un jefe
    // declarado sobre un puesto vacante es una cadena correcta pero un
    // escalamiento que hoy no llega a nadie, y eso hay que poder verlo.
    const jefe = pos.reports_to_position_code
      ? await this.knex('identity.positions')
          .where({ tenant_id: this.tenantId, code: pos.reports_to_position_code })
          .whereNull('deleted_at')
          .first('code', 'name')
      : null;
    const jefeOcupantes = jefe
      ? await this.knex('identity.users')
          .where({ tenant_id: this.tenantId, position_code: jefe.code, activo: true })
          .whereNull('deleted_at')
          .select('id', 'username', 'nombre')
      : [];

    // `[OR.1b]` De qué responde el puesto. Hoy `position_responsibilities` está
    // VACÍA a propósito (sembrarla desde el permiso colapsaría la distinción
    // «puede abrirlo» vs «responde de ello»), así que esto devuelve `[]` — y el
    // flag lo DECLARA en vez de dejar que un arreglo vacío se lea como "no
    // responde de nada".
    const responsabilidades = await this.knex('identity.position_responsibilities as pr')
      .join('identity.responsibilities as r', 'r.key', 'pr.responsibility_key')
      .where({ 'pr.tenant_id': this.tenantId, 'pr.position_code': pos.code })
      .whereNull('pr.deleted_at')
      .orderBy('r.orden')
      .select('r.key', 'r.label', 'r.dimension', 'pr.es_principal');

    return {
      position_code: pos.code,
      position_name: pos.name,
      department_code: pos.department_code ?? null,
      department_name: dept?.name ?? null,
      role_name: pos.default_role ?? null,
      /** Sin perfil sugerido: la pantalla tiene que pedirlo explícitamente. */
      sin_perfil: !pos.default_role,
      /**
       * `[OR.7.0b]` Roles complementarios que el puesto propone. ⛔ **PROPONE, no
       * otorga**: quien concede sigue siendo `identity.user_roles`. El alta los
       * precarga igual que el perfil base, y quien los quite deja el motivo.
       */
      complementos: (pos.default_complements ?? []) as string[],
      /** `[OR.1a]` El jefe que propone el puesto, y si hay alguien ocupándolo. */
      reports_to: jefe ? { code: jefe.code, name: jefe.name, ocupantes: jefeOcupantes } : null,
      jefe_sin_ocupante: !!jefe && jefeOcupantes.length === 0,
      /** `[OR.1b]` De qué responde. Vacío + `sin_responsabilidades` para no leerlo como cero. */
      responsabilidades,
      sin_responsabilidades: responsabilidades.length === 0,
      /**
       * `[ID.24]` El EJE del puesto: qué pregunta corresponde hacerle a esta
       * persona. `ruta` → su ruta · `sucursal` → su tienda · `zona` → la plaza
       * que supervisa · `red` → nada (oficinas) · `cartera` → televenta ·
       * `cliente` → externo. Resolución puesto → departamento.
       */
      scope_axis: pos.scope_axis ?? dept?.scope_axis ?? null,
      alcance,
    };
  }

  // ═══════════════════════ [ID.9] administrable desde la UI ═══════════════════
  // Regla de Edgar: el dato operativo se administra en /admin/*, no por script.
  // Un script se justifica sólo para el backfill inicial de una fase.

  /**
   * Escribe el override de alcance de un usuario en UNA dimensión
   * (`identity.user_scopes`). Hasta acá esto sólo se podía tocar por migración.
   *
   * `mode = null` BORRA el override y el usuario vuelve al default de su rol.
   * Es distinto de `mode = 'none'`, que es "explícitamente no ve nada": uno
   * hereda, el otro decide. La UI tiene que ofrecer las dos cosas.
   */
  async setScope(
    id: string,
    dimension: string,
    dto: { mode?: string | null; values?: string[] | null; mode_write?: string | null; nota?: string | null },
    requester: RequesterContext,
  ) {
    const dim = await this.knex('identity.scope_dimensions').where({ code: dimension }).first('code', 'supports_own');
    if (!dim) throw new BadRequestException(`La dimensión de alcance "${dimension}" no existe.`);

    const user = await this.knex('users').where({ id, tenant_id: this.tenantId }).first('id', 'username');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    // `[AUTHZ-HARD.0]` Frenos de escalada de alcance. Sin esto, un manager acotado a una sucursal
    // con USUARIOS_GESTIONAR se ponía `warehouse=all` a sí mismo (el override de usuario gana al
    // rol) y veía toda la red. Sólo aplica al setear un modo explícito (heredar-del-rol de abajo
    // es de-escalada y es seguro). Amplitud: none < own < listed < all.
    if (dto.mode != null) {
      const requesterRow = await this.knex('users')
        .where({ id: requester.sub, tenant_id: this.tenantId })
        .first('role_name');
      const esSuperadmin = String(requesterRow?.role_name ?? '').toLowerCase() === 'superadmin';
      if (!esSuperadmin) {
        if (requester.sub === id) {
          throw new ForbiddenException('No puedes cambiar tu propio alcance. Pedíselo a un superadmin.');
        }
        const amplitud = (m?: string | null): number =>
          ({ none: 0, own: 1, listed: 2, all: 3 } as Record<string, number>)[String(m ?? 'none')] ?? 0;
        // Alcance efectivo del que otorga para esta dimensión: su override de usuario, si no el del rol.
        const propioUser = await this.knex('identity.user_scopes')
          .where({ tenant_id: this.tenantId, user_id: requester.sub, dimension })
          .first('mode');
        const propioRol = await this.knex('identity.role_scopes')
          .whereRaw('LOWER(role_name) = ?', [String(requesterRow?.role_name ?? '').toLowerCase()])
          .andWhere({ dimension })
          .first('mode');
        const propioMode = propioUser?.mode ?? propioRol?.mode ?? 'none';
        if (amplitud(dto.mode) > amplitud(propioMode)) {
          throw new ForbiddenException(
            `No puedes otorgar un alcance "${dto.mode}" en "${dimension}": es más amplio que el tuyo ("${propioMode}").`,
          );
        }
      }
    }

    const previo = await this.knex('identity.user_scopes')
      .where({ tenant_id: this.tenantId, user_id: id, dimension })
      .first('mode', 'values', 'mode_write');

    // Heredar del rol = borrar la fila propia.
    if (dto.mode == null) {
      await this.knex('identity.user_scopes')
        .where({ tenant_id: this.tenantId, user_id: id, dimension })
        .del();
      await this.recordEvent(this.knex, id, 'scope_changed', { dimension, de: previo ?? null, a: null, hereda_del_rol: true }, requester);
      this.scopeService?.invalidateUser?.(this.tenantId, id);
      return { dimension, hereda_del_rol: true };
    }

    if (dto.mode === 'own' && !dim.supports_own) {
      throw new BadRequestException(
        `La dimensión "${dimension}" no soporta "own": no hay columna propia en el usuario de la que sacar el valor.`,
      );
    }
    const values = dto.mode === 'listed' ? (dto.values ?? []).map(String).filter(Boolean) : null;
    if (dto.mode === 'listed' && !values?.length) {
      // El CHECK de la DB también lo rechaza, pero acá el mensaje es útil.
      throw new BadRequestException('Un alcance "listed" sin valores dejaría al usuario sin ver nada. Elegí valores o usá "none".');
    }

    const fila = {
      tenant_id: this.tenantId,
      user_id: id,
      dimension,
      mode: dto.mode,
      values,
      mode_write: dto.mode_write ?? null,
      nota: dto.nota ?? null,
      updated_by: requester.sub,
      updated_at: this.knex.fn.now(),
    };
    await this.knex('identity.user_scopes')
      .insert({ ...fila, created_by: requester.sub })
      .onConflict(['tenant_id', 'user_id', 'dimension'])
      .merge(fila);

    await this.recordEvent(this.knex, id, 'scope_changed', { dimension, de: previo ?? null, a: { mode: dto.mode, values, mode_write: dto.mode_write ?? null } }, requester);
    this.scopeService?.invalidateUser?.(this.tenantId, id);
    return { dimension, mode: dto.mode, values, mode_write: dto.mode_write ?? null };
  }

  /**
   * Asignación MASIVA de los ejes de control. Es lo que hacía falta para no
   * depender de un script: normalizar 116 usuarios de a uno por pantalla no es
   * viable, y por eso el dato se quedaba viejo.
   *
   * Sólo toca los campos que vengan. Valida los códigos contra su catálogo
   * (400, no 500) y asienta un evento por usuario.
   */
  async bulkAssign(
    dto: {
      user_ids: string[];
      department_code?: string | null;
      position_code?: string | null;
      warehouse_code?: string | null;
      status?: string | null;
      /** `[OR.2]` Motivo, UNA vez para todo el lote (ver abajo). */
      motivo_desvio?: string | null;
    },
    requester: RequesterContext,
  ) {
    const ids = (dto.user_ids ?? []).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Hay que seleccionar al menos un usuario.');

    await this.assertOrgCodes(dto.department_code, dto.position_code, dto.warehouse_code);

    // `[OR.2]` El lote NO puede cambiar el rol, pero SÍ el puesto — así que
    // también puede crear divergencia, moviendo gente a un puesto que propone
    // otro perfil. Sin esto la regla quedaba a medias: se pedía motivo en el
    // alta y en la edición, y el camino masivo la esquivaba entero.
    //
    // El motivo se pide **una vez por lote**, no por persona: es UNA decisión
    // ("paso a estos 12 a `cajera` aunque su perfil sea otro"), y pedir doce
    // motivos volvería inusable justamente la herramienta que existe para
    // normalizar 116 usuarios sin depender de un script.
    let desviados: { id: string; username: string; propone: string; elegido: string }[] = [];
    if (dto.position_code) {
      const pos = await this.knex('identity.positions')
        .where({ tenant_id: this.tenantId, code: dto.position_code })
        .whereNull('deleted_at')
        .first('code', 'default_role');
      if (pos?.default_role) {
        const filas = await this.knex('users')
          .where({ tenant_id: this.tenantId })
          .whereIn('id', ids)
          .whereNull('deleted_at')
          .select('id', 'username', 'role_name', 'position_code');
        desviados = filas
          .filter(
            (u: { role_name?: string; position_code?: string }) =>
              (u.role_name ?? '').toLowerCase() !== pos.default_role.toLowerCase() &&
              (u.position_code ?? null) !== dto.position_code,
          )
          .map((u: { id: string; username: string; role_name: string }) => ({
            id: u.id,
            username: u.username,
            propone: pos.default_role,
            elegido: u.role_name,
          }));
      }
    }
    if (desviados.length && !(dto.motivo_desvio ?? '').trim()) {
      const ejemplos = desviados.slice(0, 3).map((d) => `${d.username} (${d.elegido})`).join(', ');
      throw new BadRequestException(
        `${desviados.length} de los seleccionados quedarían con un perfil distinto al que propone ` +
          `"${dto.position_code}" ("${desviados[0].propone}"): ${ejemplos}` +
          `${desviados.length > 3 ? '…' : ''}. Apartarse está permitido, pero hay que decir por qué: ` +
          `enviá "motivo_desvio".`,
      );
    }

    const cambios: Record<string, unknown> = {};
    for (const k of ['department_code', 'position_code', 'warehouse_code', 'status'] as const) {
      if (dto[k] !== undefined) cambios[k] = dto[k];
    }
    if (!Object.keys(cambios).length) throw new BadRequestException('No hay ningún campo para cambiar.');

    // Nadie se cambia a sí mismo el estado en un lote: el guard de
    // auto-desactivación del update individual no aplicaría acá.
    if (cambios['status'] && ids.includes(requester.sub)) {
      throw new ForbiddenException('No puedes cambiar tu propio estado en una asignación masiva.');
    }

    return this.knex.transaction(async (trx) => {
      const afectados = await trx('users')
        .where({ tenant_id: this.tenantId })
        .whereIn('id', ids)
        .whereNull('deleted_at')
        .update({ ...cambios, updated_at: trx.fn.now(), updated_by: requester.sub })
        .returning(['id', 'username']);

      for (const u of afectados) {
        await this.recordEvent(trx, u.id, 'bulk_assigned', cambios, requester);
      }
      // `[OR.2]` Un asiento por persona desviada, con el motivo del lote. El
      // evento es por persona aunque la decisión fuera una: dentro de seis meses
      // la pregunta va a ser "¿por qué Fulano tiene este perfil?", no "¿qué pasó
      // en aquel lote".
      for (const d of desviados) {
        if (!afectados.some((u: { id: string }) => u.id === d.id)) continue;
        await this.recordEvent(
          trx,
          d.id,
          'desvio_de_puesto',
          {
            position_code: dto.position_code,
            propone: d.propone,
            elegido: d.elegido,
            motivo: (dto.motivo_desvio ?? '').trim(),
            origen: 'asignacion masiva',
            lote: afectados.length,
          },
          requester,
        );
      }
      return { actualizados: afectados.length, campos: Object.keys(cambios), usuarios: afectados.map((u: any) => u.username) };
    });
  }

  /**
   * `[ID.13]` — Roles de un usuario: el perfil base + los complementos.
   *
   * Devuelve además el conteo de permisos de cada uno, que es lo que hace la
   * pantalla legible: "cajero (3 permisos) + captura_gastos (1)" dice mucho más
   * que dos nombres sueltos.
   */
  async roles(id: string) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const filas = await this.knex('identity.user_roles as ur')
      .leftJoin('identity.role_permissions as rp', function () {
        this.on('rp.tenant_id', '=', 'ur.tenant_id').andOn('rp.role_name', '=', 'ur.role_name');
      })
      .where({ 'ur.tenant_id': this.tenantId, 'ur.user_id': id })
      .orderBy([{ column: 'ur.is_primary', order: 'desc' }, { column: 'ur.role_name' }])
      .select(
        'ur.role_name',
        'ur.is_primary',
        'ur.nota',
        'ur.created_at',
        this.knex.raw(`(
          SELECT count(*) FROM jsonb_each(coalesce(rp.permissions, '{}'::jsonb)) e
           WHERE e.value = 'true'
        )::int AS permisos`),
      );

    return {
      user_id: id,
      username: user.username,
      perfil_base: user.role_name,
      roles: filas,
    };
  }

  /**
   * `[ID.13]` — Fija los COMPLEMENTOS de un usuario (el perfil base no se toca
   * acá: eso sigue siendo `role_name` en el formulario del usuario).
   *
   * Es la operación que resuelve dos cosas medidas en prod:
   *   - la encargada de sucursal que además cobra en caja no necesita una
   *     segunda cuenta con username de terminal;
   *   - `captura_gastos` (22 usuarios, 1 permiso) deja de ser un "rol" que
   *     además le pisaba el departamento a la persona.
   *
   * Recibe la lista COMPLETA de complementos deseados (semántica de PUT): lo
   * que no venga se quita. Devuelve qué se agregó y qué se quitó para que la
   * UI y la bitácora digan exactamente eso.
   */
  async setRoles(id: string, roleNames: string[], requester: RequesterContext) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const pedidos = Array.from(new Set((roleNames ?? []).map((r) => String(r).trim()).filter(Boolean)));

    // Los nombres se resuelven contra el catálogo (case-insensitive, igual que
    // el resto del sistema) y se guarda el CANÓNICO: la FK compuesta lo exige y
    // un rol con distinto case = 0 permisos silenciosos.
    const catalogo = await this.knex('identity.role_permissions')
      .where({ tenant_id: this.tenantId })
      .whereNull('deleted_at')
      .select('role_name');
    const porLower = new Map<string, string>(
      catalogo.map((r: { role_name: string }) => [r.role_name.toLowerCase(), r.role_name]),
    );

    const canonicos: string[] = [];
    for (const p of pedidos) {
      const c = porLower.get(p.toLowerCase());
      if (!c) throw new BadRequestException(`El rol "${p}" no existe en el catálogo.`);
      // El perfil base no se administra como complemento: si viene, se ignora
      // en silencio en vez de crear una fila que el trigger va a pelear.
      if (c.toLowerCase() !== String(user.role_name ?? '').toLowerCase()) canonicos.push(c);
    }

    const previos: string[] = await this.knex('identity.user_roles')
      .where({ tenant_id: this.tenantId, user_id: id, is_primary: false })
      .pluck('role_name');

    const agregados = canonicos.filter((c) => !previos.includes(c));
    const quitados = previos.filter((p) => !canonicos.includes(p));

    // `[AUTHZ-HARD.0]` Frenos de escalada. Sin esto, cualquiera con USUARIOS_GESTIONAR podía
    // añadirse `superadmin` como COMPLEMENTO y heredar las 164 claves por la unión de roles del
    // perms-cache (`true` gana) — la ruta que sus hermanos `update`/`setPermissions` sí frenan y
    // ésta no. Sólo aplican a lo que se AGREGA (quitar un rol nunca eleva).
    if (agregados.length) {
      const requesterRow = await this.knex('users')
        .where({ id: requester.sub, tenant_id: this.tenantId })
        .first('role_name');
      const esSuperadmin = String(requesterRow?.role_name ?? '').toLowerCase() === 'superadmin';

      // (a) Rol elevado (superadmin/admin) sólo lo asigna un superadmin.
      for (const rol of agregados) {
        await this.assertCanAssignRole(rol, requester);
      }

      if (!esSuperadmin) {
        // (b) No editarse los propios roles.
        if (requester.sub === id) {
          throw new ForbiddenException(
            'No puedes cambiarte tus propios roles. Pedíselo a un superadmin.',
          );
        }
        // (c) Techo: no otorgar un rol cuyo mapa tenga claves que el que otorga NO tiene.
        const propios = await this.permsCache?.getPermissionsForUser?.(
          requester.sub,
          this.tenantId,
          requesterRow?.role_name,
        );
        for (const rol of agregados) {
          const mapa = await this.permsCache?.getPermissionsForRole?.(rol, this.tenantId);
          const claves = Object.entries(mapa ?? {})
            .filter(([, v]) => v === true)
            .map(([k]) => k);
          const sinTener = claves.filter((k) => propios?.[k] !== true);
          if (sinTener.length) {
            throw new ForbiddenException(
              `No puedes otorgar el rol "${rol}": incluye permisos que no tenés (${sinTener
                .slice(0, 5)
                .join(', ')}${sinTener.length > 5 ? '…' : ''}).`,
            );
          }
        }
      }
    }
    if (!agregados.length && !quitados.length) {
      return { user_id: id, complementos: canonicos, agregados: [], quitados: [] };
    }

    await this.knex.transaction(async (trx) => {
      if (quitados.length) {
        await trx('identity.user_roles')
          .where({ tenant_id: this.tenantId, user_id: id, is_primary: false })
          .whereIn('role_name', quitados)
          .del();
      }
      for (const rol of agregados) {
        const fila = {
          tenant_id: this.tenantId,
          user_id: id,
          role_name: rol,
          is_primary: false,
          updated_by: requester.sub,
          updated_at: trx.fn.now(),
        };
        await trx('identity.user_roles')
          .insert({ ...fila, created_by: requester.sub })
          .onConflict(['tenant_id', 'user_id', 'role_name'])
          .merge(fila);
      }
      await this.recordEvent(
        trx,
        id,
        'roles_changed',
        { agregados, quitados, complementos: canonicos, perfil_base: user.role_name },
        requester,
      );
    });

    // El guard cachea la LISTA de roles 30s; sin esto el complemento nuevo
    // tarda hasta medio minuto en verse y parece que no se guardó.
    this.permsCache?.invalidateUser?.(id, this.tenantId);

    return { user_id: id, complementos: canonicos, agregados, quitados };
  }

  /**
   * `[ID.21]` — Acceso VIGENTE del usuario en sesión, para que el front no dependa
   * del snapshot del JWT.
   *
   * El problema concreto: los permisos viajan en el token (ADR-050), así que el
   * backend aplica un cambio en ≤30s pero el MENÚ sigue mostrando lo de antes
   * hasta que la persona vuelve a entrar. Con permisos por usuario eso se vuelve
   * la queja principal — "le di el permiso y no le aparece". El front llama esto
   * al arrancar y refresca su mapa sin re-login.
   *
   * Devuelve el MAPA de permisos y nada más. Antes devolvía además `rules` de CASL para el
   * `PermissionsService` del front; ese front ya gatea por clave exacta contra `permissions`, así
   * que las reglas eran una segunda copia de la misma verdad (y la más pobre de las dos).
   */
  async accessFor(userId: string, roleName?: string) {
    const permisos =
      (await this.permsCache?.getPermissionsForUser?.(userId, this.tenantId, roleName)) ??
      (await (async () => {
        // Sin cache (tests): se reconstruye desde la misma fuente.
        const detalle = await this.permissions(userId);
        return Object.fromEntries(detalle.efectivos.map((k: string) => [k, true]));
      })());
    // Ya no se devuelven reglas de CASL: el front gatea por clave exacta contra `permissions`.
    return { user_id: userId, role_name: roleName ?? null, permissions: permisos };
  }

  /**
   * `[SN.2]` — Contexto de la persona en sesión, para el bloque "Mi contexto" de la landing.
   *
   * Self-scoped: sólo se pregunta por el propio `userId` (el controller lo saca del JWT), por eso
   * no pasa por `alcanceDelPadron` ni pide permiso. Mismos LEFT JOIN que `findOne` para puesto y
   * departamento; si la persona no tiene puesto, `position` es `null` y se DECLARA así — nunca se
   * deriva del rol (la migración que asignó puestos lo dejó NULL a propósito en dos roles).
   */
  async contextFor(userId: string): Promise<MeContext> {
    const u = await this.knex('users as u')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .leftJoin('identity.departments as dp', function () {
        this.on('dp.tenant_id', '=', 'u.tenant_id');
        this.on('dp.code', '=', 'u.department_code');
      })
      .leftJoin('identity.positions as ps', function () {
        this.on('ps.tenant_id', '=', 'u.tenant_id');
        this.on('ps.code', '=', 'u.position_code');
      })
      .where('u.id', userId)
      .where('u.tenant_id', this.tenantId)
      .select(
        'u.id',
        'u.username',
        'u.nombre',
        'u.role_name',
        'u.kind',
        'u.warehouse_code',
        'z.name as zona',
        'u.department_code',
        'dp.name as department_name',
        'u.position_code',
        'ps.name as position_name',
      )
      .first();
    if (!u) throw new NotFoundException('Usuario en sesión no encontrado');
    return {
      user_id: u.id,
      username: u.username,
      nombre: u.nombre ?? null,
      role_name: u.role_name ?? null,
      kind: u.kind ?? null,
      warehouse_code: u.warehouse_code ?? null,
      zona: u.zona ?? null,
      department: u.department_code
        ? { code: u.department_code, name: u.department_name ?? u.department_code }
        : null,
      position: u.position_code
        ? { code: u.position_code, name: u.position_name ?? u.position_code }
        : null,
    };
  }

  /**
   * `[SN.7]` — Trabajo pendiente de la persona en sesión: lo que le toca HACER, no a dónde puede
   * entrar. Alimenta el bloque "Mi trabajo" de la landing.
   *
   * Self-scoped y sin permiso propio, como `me/context`: cada bandeja ya trae el suyo y sólo se
   * cuenta la que esta persona puede abrir (un conteo es información). El registro de bandejas,
   * con la medición que lo justifica, vive en `me-work.ts`.
   *
   * Cada conteo va en su propio `try`: si una tabla no existe todavía en este ambiente (una fase a
   * medio desplegar), esa bandeja se DECLARA en `no_medido` con su motivo y las demás siguen
   * contando. Nunca baja a cero — un cero dibujado se lee igual que "estás al día" (ADR-056).
   */
  async workFor(
    userId: string,
    permisos: Record<string, boolean> | null | undefined,
    esAdmin: boolean,
  ): Promise<MeWork> {
    const pendientes: MePendiente[] = [];
    const tareas: MeTarea[] = [];
    const no_medido: MeWork['no_medido'] = [];

    /*
     * `[SN.15]` El alcance se resuelve UNA vez, ANTES de contar y FUERA de cualquier `tk.run`:
     * `ScopeService` abre su propia conexión y anidar transacciones ya cobró antes en este repo.
     *
     * ⛔ `[]` NO se propaga. `applyTo()` emite el mismo `WHERE false` para `none` que para un `own`
     * cuya ficha está vacía, y la ficha está vacía en el **74%** de quienes ven la bandeja de
     * reabasto (medido en prod). Un `[]` acá convertiría "tu ficha no tiene sucursal" en "estás al
     * día". Por eso sólo se acota cuando el alcance es RESOLUBLE y tiene valores; si no, se cuenta
     * toda la red y la fila lo dice (ADR-056 / `[ID.26]`).
     */
    const sucursales = await this.sucursalesDelAlcance(userId);
    const ctx: MedirCtx = { tenantId: this.tenantId, userId, sucursales };

    for (const b of BANDEJAS) {
      if (!puedeVerBandeja(b, permisos, esAdmin)) continue;
      try {
        const { total, mas_viejo_at } = await b.medir(this.knex, ctx);
        // Una bandeja en cero no se pinta: la pantalla no tiene cajas vacías.
        if (total > 0) {
          pendientes.push({
            id: b.id,
            label: b.label,
            detalle: b.detalle,
            ruta: b.ruta,
            icono: b.icono,
            total,
            mas_viejo_at,
            alcance: b.alcance,
            // El universo del conteo se DECLARA. "Se podría acotar pero tu ficha no tiene
            // sucursal" no es lo mismo que "esta cola no tiene sucursal", y ninguna de las dos
            // es "acotado a lo tuyo".
            ambito: !b.acotablePorSucursal ? 'red' : sucursales ? 'sucursal' : 'red_sin_ficha',
          });
        }
      } catch (e) {
        const motivo = e instanceof Error ? e.message.split('\n')[0] : 'error desconocido';
        this.logger.warn(`me/work: bandeja ${b.id} no se pudo contar — ${motivo}`);
        no_medido.push({ id: b.id, label: b.label, motivo });
      }
    }

    /*
     * `[SN.12]` Lo propio primero, y dentro de cada grupo lo MÁS VIEJO arriba — no lo más grande.
     * Ordenar por volumen ponía 1,865 descuadres sobre 5 alertas de flota, y el tamaño de una cola
     * no dice nada de su urgencia: una cola grande puede llevar meses estable y una de cinco
     * elementos puede ser un vehículo sin señal desde ayer. La bandeja sin fecha medible NO se
     * asume reciente: cae al final de su grupo y ahí el volumen desempata (ADR-056).
     */
    const edad = (p: { mas_viejo_at: string | null }): number =>
      p.mas_viejo_at ? Date.parse(p.mas_viejo_at) : Number.POSITIVE_INFINITY;
    pendientes.sort((a, b) => {
      if (a.alcance !== b.alcance) return a.alcance === 'mio' ? -1 : 1;
      const ea = edad(a);
      const eb = edad(b);
      if (ea !== eb) return ea - eb;
      return b.total - a.total;
    });

    /*
     * `[SN.15]` Lo que ALGUIEN te asignó. Va aparte de `pendientes` porque una tarea y una cola no
     * son lo mismo: la tarea tiene dueño y fecha, la cola no. Ver `work/task.contract.ts`.
     *
     * La fila se muestra AUNQUE la persona no tenga el permiso que abre su ruta — en ese caso sin
     * enlace y con el motivo. Esconderla taparía la discrepancia entre quién reparte y quién puede
     * abrir; enlazarla invitaría a un 403 (medido en prod: 2 conteos asignados a gente sin la
     * clave). Es un hallazgo, no un error que convenga disimular.
     */
    for (const f of FUENTES_VISIBLES) {
      try {
        const m = await f.medir(this.knex, this.tenantId, userId);
        if (m.total === 0) continue;
        const puede = puedeAbrirTarea(f, permisos, esAdmin);
        tareas.push({
          fuente: f.fuente,
          label: f.label,
          detalle: f.detalle,
          ruta: puede ? f.ruta : null,
          sin_acceso: puede
            ? null
            : `Te la asignaron, pero tu permiso no abre ${f.ruta}. Pídeselo a Sistemas.`,
          icono: f.icono,
          total: m.total,
          mas_viejo_at: m.mas_viejo_at,
          vence_at: m.vence_at,
          vencidas: m.vencidas,
          no_responde: adaptadorDe(f.fuente).no_responde,
        });
      } catch (e) {
        const motivo = e instanceof Error ? e.message.split('\n')[0] : 'error desconocido';
        this.logger.warn(`me/work: tarea ${f.fuente} no se pudo contar — ${motivo}`);
        no_medido.push({ id: f.fuente, label: f.label, motivo });
      }
    }
    // Lo vencido primero; después lo que vence antes; al final lo que no vence, por antigüedad.
    tareas.sort((a, b) => {
      const va = (a.vencidas ?? 0) > 0 ? 0 : 1;
      const vb = (b.vencidas ?? 0) > 0 ? 0 : 1;
      if (va !== vb) return va - vb;
      const fa = a.vence_at ? Date.parse(a.vence_at) : Number.POSITIVE_INFINITY;
      const fb = b.vence_at ? Date.parse(b.vence_at) : Number.POSITIVE_INFINITY;
      if (fa !== fb) return fa - fb;
      return edad(a) - edad(b);
    });

    return {
      tareas,
      pendientes,
      no_medido,
      tiene_responsabilidades: await this.tieneResponsabilidades(userId),
      medido_at: new Date().toISOString(),
    };
  }

  /**
   * `[SN.15]` Los códigos de sucursal a los que se acota el conteo de esta persona, o `null` para
   * "no acotar".
   *
   * `null` cubre TRES casos que la pantalla necesita distinguir de "no tenés nada":
   *   · alcance `all` (ve la red entera, por diseño),
   *   · `resolvable: false` — la ficha no tiene `warehouse_code` (**78 de 122** personas),
   *   · no hay `ScopeService` (los tests instancian el service sin él).
   *
   * Nunca devuelve `[]`: un array vacío filtraría a cero y se leería como "estás al día".
   */
  private async sucursalesDelAlcance(userId: string): Promise<string[] | null> {
    if (!this.scopeService) return null;
    try {
      const scope = await this.scopeService.forUser(this.tenantId, userId);
      const dim = scope.dims.warehouse;
      if (!dim || dim.mode === 'all' || !dim.resolvable) return null;
      return dim.values.length ? dim.values : null;
    } catch (e) {
      // El alcance es una MEJORA del conteo, no su requisito: si falla, se cuenta todo y se dice.
      this.logger.warn(
        `me/work: no se pudo resolver el alcance de ${userId} — ${e instanceof Error ? e.message : e}`,
      );
      return null;
    }
  }

  /**
   * `[SN.15]` ¿El puesto de esta persona tiene declarado de qué responde?
   *
   * Es la segunda de las tres preguntas (`work/task.contract.ts`): el permiso dice si podés
   * abrirlo, la responsabilidad dice si es TUYO. Hoy la respuesta es **no para todos**:
   * `identity.position_responsibilities` tiene 0 filas a propósito — `[OR.1b]` se negó a sembrarla
   * desde el permiso porque eso colapsaría justo la distinción que la tabla crea (medido: una
   * auxiliar de marketing puede ABRIR 6 de las 8 bandejas, incluidos 82,289 hallazgos de finanzas).
   *
   * La pantalla usa esto para DECLARAR por qué no puede decir "esto es tuyo", en vez de callarlo.
   * `null` = no se pudo consultar (la migración no llegó a este ambiente), que no es `false`.
   */
  private async tieneResponsabilidades(userId: string): Promise<boolean | null> {
    try {
      const row = await this.knex('identity.position_responsibilities as pr')
        .join('identity.users as u', function () {
          this.on('u.position_code', '=', 'pr.position_code').andOn('u.tenant_id', '=', 'pr.tenant_id');
        })
        .where('u.id', userId)
        .where('pr.tenant_id', this.tenantId)
        .whereNull('pr.deleted_at')
        .first(this.knex.raw('1 as hay'));
      return !!row;
    } catch {
      return null;
    }
  }

  /**
   * `[ID.21]` — Permisos de una persona: lo que le da su puesto, lo que tiene de
   * más o de menos, y lo que aplica de verdad.
   *
   * Devuelve las tres capas por separado en vez de un solo mapa aplanado, porque
   * la pregunta que se hace frente a la pantalla no es "qué puede hacer" sino
   * "por qué puede hacer esto" — y la respuesta útil es "se lo da el puesto" o
   * "alguien se lo dio a él, con esta nota, este día".
   */
  async permissions(id: string) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'nombre', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const roles = await this.knex('identity.user_roles')
      .where({ tenant_id: this.tenantId, user_id: id })
      .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'role_name' }])
      .select('role_name', 'is_primary');
    // Fallback: si no hay filas (usuario viejo, migración sin correr) el perfil
    // base sigue siendo `users.role_name`. Mismo criterio que el guard.
    const nombresRol = roles.length ? roles.map((r) => r.role_name) : [user.role_name].filter(Boolean);

    // El estándar del puesto = unión de los roles, `true` gana.
    const delPuesto: Record<string, boolean> = {};
    if (nombresRol.length) {
      const filas = await this.knex('identity.role_permissions')
        .where({ tenant_id: this.tenantId })
        .whereRaw(
          `LOWER(role_name) = ANY(?)`,
          [nombresRol.map((r: string) => String(r).toLowerCase())],
        )
        .select('permissions');
      for (const f of filas as Array<{ permissions: Record<string, boolean> }>) {
        for (const [k, v] of Object.entries(f.permissions ?? {})) {
          if (v === true) delPuesto[k] = true;
        }
      }
    }

    const overrides = await this.knex('identity.user_permissions')
      .where({ tenant_id: this.tenantId, user_id: id })
      .orderBy('permission_key')
      .select('permission_key', 'allow', 'nota', 'granted_by_username', 'created_at', 'updated_at');

    const efectivos: Record<string, boolean> = { ...delPuesto };
    for (const o of overrides) {
      if (o.allow) efectivos[o.permission_key] = true;
      else delete efectivos[o.permission_key];
    }

    return {
      user_id: id,
      username: user.username,
      nombre: user.nombre,
      perfil_base: user.role_name,
      roles,
      // `superadmin` pasa por `manage:all` antes de mirar el mapa: los overrides
      // no le muerden. La UI lo dice en vez de mostrar casillas que no hacen nada.
      platform_admin: ELEVATED_ROLES.has(String(user.role_name ?? '').toLowerCase()),
      del_puesto: Object.keys(delPuesto).sort(),
      efectivos: Object.keys(efectivos).sort(),
      overrides,
      de_mas: overrides.filter((o) => o.allow).map((o) => o.permission_key),
      de_menos: overrides.filter((o) => !o.allow).map((o) => o.permission_key),
    };
  }

  /**
   * `[ID.21]` — Fija los permisos PROPIOS de una persona (la diferencia contra el
   * estándar de su puesto). Semántica de PUT: la lista que llega es la final.
   *
   * Tres cosas que este método NO deja hacer, y el motivo:
   *
   *   1. **Overrides sobre un rol de plataforma.** `isPlatformAdminRole` deja pasar a
   *      superadmin/admin antes de mirar el mapa y el guard corta ahí. Un `allow=false`
   *      quedaría guardado y no haría nada: peor que no poder, porque el admin
   *      cree que revocó. Se rechaza con el motivo.
   *   2. **Otorgar lo que quien edita no tiene.** Con `USUARIOS_GESTIONAR`
   *      alcanzaría para darse a sí mismo cualquier permiso del sistema. Un
   *      superadmin está exento (ya tiene todo).
   *   3. **Darse permisos a uno mismo.** Un no-superadmin editando su propia
   *      ficha es exactamente el camino de escalación, aunque el permiso ya lo
   *      tenga por rol.
   */
  async setPermissions(
    id: string,
    overrides: Array<{ permission_key: string; allow: boolean; nota?: string | null }>,
    requester: RequesterContext,
  ) {
    const user = await this.knex('users')
      .where({ id, tenant_id: this.tenantId })
      .first('id', 'username', 'role_name');
    if (!user) throw new NotFoundException(`Usuario con ID ${id} no encontrado`);

    const requesterRow = await this.knex('users')
      .where({ id: requester.sub, tenant_id: this.tenantId })
      .first('role_name');
    const esSuperadmin = String(requesterRow?.role_name ?? '').toLowerCase() === 'superadmin';

    const pedidos = (overrides ?? []).filter((o) => o && o.permission_key);
    if (ELEVATED_ROLES.has(String(user.role_name ?? '').toLowerCase()) && pedidos.length) {
      throw new BadRequestException(
        `"${user.role_name}" ya tiene acceso total por rol: los permisos por usuario no le aplican. ` +
          `Para limitar a esta persona hay que cambiarle el perfil base.`,
      );
    }

    // Claves válidas = el enum. El CHECK de la tabla valida la FORMA; esto valida
    // que EXISTA. Un permiso mal escrito se guarda feliz y no hace nada.
    const validas = new Set<string>(Object.values(Permission) as string[]);
    for (const o of pedidos) {
      if (!validas.has(o.permission_key)) {
        throw new BadRequestException(`El permiso "${o.permission_key}" no existe.`);
      }
    }

    if (!esSuperadmin) {
      if (requester.sub === id) {
        throw new ForbiddenException(
          'No puedes editar tus propios permisos. Pedíselo a un superadmin.',
        );
      }
      const propios = await this.permsCache?.getPermissionsForUser?.(
        requester.sub,
        this.tenantId,
        requesterRow?.role_name,
      );
      const otorgando = pedidos.filter((o) => o.allow).map((o) => o.permission_key);
      const sinTener = otorgando.filter((k) => propios?.[k] !== true);
      if (sinTener.length) {
        throw new ForbiddenException(
          `No puedes otorgar permisos que no tenés: ${sinTener.join(', ')}.`,
        );
      }
    }

    const previos = await this.knex('identity.user_permissions')
      .where({ tenant_id: this.tenantId, user_id: id })
      .select('permission_key', 'allow');
    const previoDe = new Map<string, boolean>(previos.map((p) => [p.permission_key, p.allow]));
    const pedidoDe = new Map<string, { allow: boolean; nota?: string | null }>(
      pedidos.map((o) => [o.permission_key, { allow: !!o.allow, nota: o.nota ?? null }]),
    );

    const quitados = Array.from(previoDe.keys()).filter((k) => !pedidoDe.has(k));
    const cambiados = Array.from(pedidoDe.entries()).filter(
      ([k, v]) => !previoDe.has(k) || previoDe.get(k) !== v.allow,
    );
    if (!quitados.length && !cambiados.length) {
      return { user_id: id, overrides: pedidos, agregados: [], quitados: [], sin_cambios: true };
    }

    await this.knex.transaction(async (trx) => {
      if (quitados.length) {
        await trx('identity.user_permissions')
          .where({ tenant_id: this.tenantId, user_id: id })
          .whereIn('permission_key', quitados)
          .del();
      }
      for (const [key, v] of pedidoDe.entries()) {
        const fila = {
          tenant_id: this.tenantId,
          user_id: id,
          permission_key: key,
          allow: v.allow,
          nota: v.nota,
          granted_by: requester.sub,
          granted_by_username: requester.username ?? null,
          updated_at: trx.fn.now(),
        };
        await trx('identity.user_permissions')
          .insert(fila)
          .onConflict(['tenant_id', 'user_id', 'permission_key'])
          .merge(fila);
      }
      await this.recordEvent(
        trx,
        id,
        'permissions_changed',
        {
          concedidos: cambiados.filter(([, v]) => v.allow).map(([k]) => k),
          revocados: cambiados.filter(([, v]) => !v.allow).map(([k]) => k),
          vueltos_al_puesto: quitados,
          perfil_base: user.role_name,
        },
        requester,
      );
    });

    // El guard cachea los overrides 30s: sin esto el cambio tarda medio minuto
    // en aplicar y parece que no se guardó.
    this.permsCache?.invalidateUser?.(id, this.tenantId);

    return {
      user_id: id,
      overrides: pedidos,
      agregados: cambiados.map(([k]) => k),
      quitados,
    };
  }

  /** Bitácora del usuario, para el panel de detalle. */
  async events(id: string, limit = 50) {
    return this.knex('identity.user_events')
      .where({ tenant_id: this.tenantId, user_id: id })
      .orderBy('created_at', 'desc')
      .limit(Math.min(200, Math.max(1, limit)))
      .select('event', 'detalle', 'actor_username', 'created_at');
  }
}
