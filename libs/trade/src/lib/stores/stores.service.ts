import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, ScopeService, TenantContextService } from '@megadulces/platform-core';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';
import {
  CUSTOMER_PROVISIONING_PORT,
  CustomerProvisioningPort,
} from '@megadulces/contracts';

interface RequesterContext {
  sub: string;
  /** Mapa de permisos que el guard relee del cache en cada request. */
  permissions?: Record<string, boolean> | null;
  role_name?: string | null;
}

@Injectable()
export class StoresService {
  private readonly logger = new Logger(StoresService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly scope: ScopeService,
    private readonly tenantCtx: TenantContextService,
    @Optional()
    @Inject(CUSTOMER_PROVISIONING_PORT)
    private readonly customerProvisioning?: CustomerProvisioningPort,
  ) {}

  private haversine(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * `[AUTHZ-HARD.3]` — Zonas que el requester puede ver, resueltas por el
   * `ScopeService` (dimensión `zone`). Reemplaza al viejo `getRequesterZonaId`,
   * que mezclaba ejes (`getDataScope`, que es la jerarquía de REPORTES) y era
   * fail-OPEN: un usuario sin `zona_id` resolvía a `null` = "ve TODAS las zonas".
   *
   *   - `null`  → alcance `all` → sin filtro (dirección, marketing, admin…).
   *   - `[...]` → sus zonas (uuid). `own` = la de su ficha; `listed` = varias.
   *   - `[]`    → alcance `none` → ninguna (fail-closed).
   *
   * Se resuelve por `forUser` con el `sub` del requester + el tenant del CLS
   * (igual que `users.controller`), robusto a que el CLS traiga o no el userId.
   */
  private async getRequesterZones(
    requester: RequesterContext,
  ): Promise<string[] | null> {
    const scope = await this.scope.forUser(
      this.tenantCtx.requireTenantId(),
      requester.sub,
      requester.role_name ?? undefined,
    );
    const d = scope.dims.zone;
    if (d.mode === 'all') return null;
    return d.values;
  }

  async findNearby(
    lat: number,
    lng: number,
    radiusMeters = 30,
    requester?: RequesterContext,
  ) {
    const latDelta = radiusMeters / 111_320;
    const lngDelta =
      radiusMeters /
      (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.0001));

    const query = this.knex('stores')
      .where({ activo: true })
      .whereNotNull('latitud')
      .whereNotNull('longitud')
      .where('latitud', '!=', 0)
      .where('longitud', '!=', 0)
      .whereBetween('latitud', [lat - latDelta, lat + latDelta])
      .whereBetween('longitud', [lng - lngDelta, lng + lngDelta])
      .select('*');

    if (requester) {
      const zones = await this.getRequesterZones(requester);
      // Incluir tiendas SIN zona asignada: una tienda frente a la que estás
      // parado debe ser detectable aunque no tenga zona_id. Sin este OR, un
      // usuario scopeado a zona NUNCA detecta tiendas con zona_id NULL (todas,
      // hoy) → "no se reconoce la tienda". La cercanía geográfica ya acota.
      // `[]` (alcance `none`) NO incluye las de zona nula: no ve nada.
      if (zones) {
        query.where((b) => {
          b.whereIn('zona_id', zones);
          if (zones.length) b.orWhereNull('zona_id');
        });
      }
    }

    const stores = await query;

    return stores
      .map((store) => ({
        id: store.id,
        nombre: store.nombre,
        direccion: store.direccion,
        latitud: store.latitud,
        longitud: store.longitud,
        distance: Math.round(
          this.haversine(
            lat,
            lng,
            Number(store.latitud),
            Number(store.longitud),
          ),
        ),
      }))
      .filter((s) => s.distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance);
  }

  /**
   * Devuelve el "version stamp" del catalogo de tiendas (la fecha mas
   * reciente entre updated_at y created_at). El frontend lo compara con
   * el version cacheado en IndexedDB para decidir si redescargar el
   * catalogo completo (mismo patron que planograms/brands/version).
   *
   * Scope-aware: si el requester esta restringido a una zona, la version
   * se calcula solo sobre las tiendas de esa zona.
   */
  async getCatalogVersion(requester?: RequesterContext) {
    const query = this.knex('stores')
      .where({ activo: true })
      .select(
        this.knex.raw('MAX(GREATEST(updated_at, created_at)) as version'),
      );

    if (requester) {
      const zones = await this.getRequesterZones(requester);
      if (zones) query.whereIn('zona_id', zones);
    }

    const row = await query.first();
    return { version: row?.version ?? null };
  }

  /**
   * Catalogo completo de tiendas activas (con coordenadas) para cache
   * offline en IndexedDB. El frontend lo usa para detectar la tienda mas
   * cercana via Haversine cuando no hay red.
   *
   * Solo incluye tiendas con lat/lng validos — sin coords no se puede
   * hacer matching offline.
   */
  async findAllForOfflineSync(requester?: RequesterContext) {
    const query = this.knex('stores')
      .where({ activo: true })
      .whereNotNull('latitud')
      .whereNotNull('longitud')
      .where('latitud', '!=', 0)
      .where('longitud', '!=', 0)
      .select('id', 'nombre', 'direccion', 'latitud', 'longitud', 'zona_id');

    if (requester) {
      const zones = await this.getRequesterZones(requester);
      // Igual que findNearby: el cache offline debe incluir tiendas sin zona,
      // si no la detección Haversine offline tampoco las encuentra. `none` (`[]`)
      // no ve ninguna, ni las de zona nula.
      if (zones) {
        query.where((b) => {
          b.whereIn('zona_id', zones);
          if (zones.length) b.orWhereNull('zona_id');
        });
      }
    }

    return query.orderBy('nombre', 'asc');
  }

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const cleaned = zonaName.trim();
    const zone = await this.knex('zones')
      .whereRaw('LOWER(name) = ?', [cleaned.toLowerCase()])
      .select('id')
      .first();
    return zone?.id || null;
  }

  /**
   * Valida que `ruta_id` exista, esté activa, y pertenezca a `zona_id`.
   * Si zona_id es null no se valida la pertenencia (solo existencia + activa).
   */
  private async assertRouteValid(
    routeId: string,
    zonaId: string | null,
  ): Promise<void> {
    const route = await this.knex('catalogs')
      .where({ id: routeId, catalog_id: 'rutas' })
      .select('id', 'parent_id', 'deleted_at')
      .first();
    if (!route) throw new NotFoundException('Ruta no encontrada');
    if (route.deleted_at !== null) {
      throw new BadRequestException('La ruta seleccionada está inactiva');
    }
    if (zonaId && route.parent_id && route.parent_id !== zonaId) {
      throw new BadRequestException(
        'La ruta no pertenece a la zona seleccionada.',
      );
    }
  }

  /**
   * Verifica que el requester pueda operar sobre la tienda dada según su scope.
   * Devuelve la fila (con zona_id) para evitar un segundo SELECT.
   */
  private async assertCanAccessStore(
    storeId: string,
    requester: RequesterContext,
  ): Promise<{ id: string; zona_id: string | null }> {
    const store = await this.knex('stores')
      .where({ id: storeId })
      .select('id', 'zona_id')
      .first();
    if (!store) {
      throw new NotFoundException(
        'Requerimiento fallido: Tienda o Punto de Venta no encontrado.',
      );
    }
    const zones = await this.getRequesterZones(requester);
    // `null` = alcance `all` (puede operar en cualquiera). Con lista, la zona de
    // la tienda debe estar incluida; una tienda de zona nula tampoco es operable
    // por un usuario scopeado (igual que antes).
    if (zones && !zones.includes(store.zona_id as string)) {
      throw new ForbiddenException(
        'No puedes operar sobre tiendas fuera de tu zona.',
      );
    }
    return store;
  }

  async findAll(
    zona_id?: string,
    ruta_id?: string,
    requester?: RequesterContext,
  ) {
    const query = this.knex('stores as s')
      .leftJoin('zones as z', 's.zona_id', 'z.id')
      .leftJoin('catalogs as c', 's.ruta_id', 'c.id')
      .where({ 's.activo': true })
      .select(
        's.id',
        's.nombre',
        's.direccion',
        's.latitud',
        's.longitud',
        's.activo',
        's.zona_id',
        's.ruta_id',
        's.created_at',
        'z.name as zona',
        'c.value as ruta_nombre',
      )
      .orderBy('s.nombre', 'asc');

    // Scope enforcement: si el requester está restringido a una zona, ignora
    // cualquier zona_id distinto que venga del cliente.
    if (requester) {
      const zones = await this.getRequesterZones(requester);
      if (zones) {
        query.whereIn('s.zona_id', zones);
      } else if (zona_id) {
        query.where('s.zona_id', zona_id);
      }
    } else if (zona_id) {
      query.where('s.zona_id', zona_id);
    }

    if (ruta_id) {
      query.where('s.ruta_id', ruta_id);
    }

    return query;
  }

  async create(data: CreateStoreDto, requester: RequesterContext) {
    const { zona, ...rest } = data;
    const zona_id = await this.resolveZonaId(zona);

    // Scope: si el requester está acotado a zonas, no puede crear fuera de ellas.
    const zones = await this.getRequesterZones(requester);
    if (zones && zona_id && !zones.includes(zona_id)) {
      throw new ForbiddenException(
        'No puedes crear tiendas fuera de tu zona.',
      );
    }

    if (rest.ruta_id) {
      await this.assertRouteValid(rest.ruta_id, zona_id);
    }

    const [store] = await this.knex('stores')
      .insert({ ...rest, zona_id, updated_by: requester.sub })
      .returning('*');

    // Modelo 1:1 tienda↔cliente: provisiona el cliente comercial al alta.
    // Best-effort (no atómico): si falla no rompe la creación de la tienda.
    if (this.customerProvisioning) {
      try {
        await this.customerProvisioning.ensureCustomerForStore(store.id);
      } catch (e) {
        this.logger.warn(
          `Auto-provisión de cliente para store ${store.id} falló: ${(e as Error)?.message}`,
        );
      }
    }

    return { ...store, zona };
  }

  async remove(id: string, requester: RequesterContext) {
    await this.assertCanAccessStore(id, requester);

    // Soft delete: marcar inactiva en lugar de borrar físicamente, para
    // preservar el vínculo histórico con daily_captures.store_id.
    const [store] = await this.knex('stores')
      .where({ id })
      .update({
        activo: false,
        deleted_at: this.knex.fn.now(),
        deleted_by: requester.sub,
        updated_at: this.knex.fn.now(),
        updated_by: requester.sub,
      })
      .returning('*');
    return store;
  }

  async update(id: string, data: UpdateStoreDto, requester: RequesterContext) {
    const existing = await this.assertCanAccessStore(id, requester);

    const { zona, zona_id, ruta_id, ...rest } = data;
    const updateData: Record<string, unknown> = { ...rest };

    if (zona_id !== undefined) {
      updateData['zona_id'] = zona_id;
    } else if (zona !== undefined) {
      updateData['zona_id'] = await this.resolveZonaId(zona);
    }

    if (ruta_id !== undefined) {
      updateData['ruta_id'] = ruta_id;
    }

    // Validar ruta∈zona si se está cambiando alguna de las dos.
    if (ruta_id) {
      const effectiveZonaId =
        (updateData['zona_id'] as string | null | undefined) ??
        existing.zona_id;
      await this.assertRouteValid(ruta_id, effectiveZonaId ?? null);
    }

    // Scope post-cambio: no permitir mover tiendas a otra zona si el
    // requester no tiene scope global.
    const zones = await this.getRequesterZones(requester);
    if (
      zones &&
      updateData['zona_id'] !== undefined &&
      !zones.includes(updateData['zona_id'] as string)
    ) {
      throw new ForbiddenException(
        'No puedes mover tiendas fuera de tu zona.',
      );
    }

    if (Object.keys(updateData).length === 0) {
      const existingFull = await this.knex('stores').where({ id }).first();
      return existingFull;
    }

    updateData['updated_at'] = this.knex.fn.now();
    updateData['updated_by'] = requester.sub;

    const [store] = await this.knex('stores')
      .where({ id })
      .update(updateData)
      .returning('*');

    const zoneName =
      zona !== undefined
        ? zona
        : (
            await this.knex('zones')
              .where({ id: store.zona_id })
              .select('name')
              .first()
          )?.name;

    const routeName = store.ruta_id
      ? (
          await this.knex('catalogs')
            .where({ id: store.ruta_id })
            .select('value')
            .first()
        )?.value
      : null;

    return { ...store, zona: zoneName, ruta_nombre: routeName };
  }
}
