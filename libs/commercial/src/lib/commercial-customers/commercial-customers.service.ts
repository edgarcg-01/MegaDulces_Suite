import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { vendorTodayRouteExistsSql } from '../shared/vendor-cartera.sql';
import {
  AddressJsonbSchema,
  AddressJsonb,
  validateJsonb,
} from '@megadulces/platform-core';
import { CustomerProvisioningPort } from '@megadulces/contracts';

export interface CreateCustomerDto {
  code: string;
  name: string;
  legal_name?: string;
  rfc?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  sales_route?: string;
  billing_address?: AddressJsonb;
  shipping_address?: AddressJsonb;
  store_id?: string;
  default_price_list_id?: string;
  route_id?: string | null;
  credit_limit?: number;
  payment_terms_days?: number;
  active?: boolean;
  notes?: string;
}

export type UpdateCustomerDto = Partial<CreateCustomerDto>;

export interface ListCustomersQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  active?: boolean;
  /** Restringe a la cartera del vendedor del JWT (vendor_sales_routes) y ordena por visit_sequence. */
  mine?: boolean;
}

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const E164_REGEX = /^\+\d{8,15}$/;

/** Normaliza a E.164 (MX por defecto: 10 dígitos → +52...). Null si vacío; lanza si no forma un E.164 válido. */
function normalizeWhatsapp(raw?: string | null): string | null {
  if (raw == null) return null;
  const hadPlus = String(raw).trim().startsWith('+');
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  let e164: string;
  if (hadPlus) e164 = '+' + digits;
  else if (digits.length === 10) e164 = '+52' + digits;
  else if (digits.length === 12 && digits.startsWith('52')) e164 = '+' + digits;
  else if (digits.length === 13 && digits.startsWith('521')) e164 = '+52' + digits.slice(3);
  else e164 = '+' + digits;
  if (!E164_REGEX.test(e164)) {
    throw new BadRequestException('whatsapp inválido: usar 10 dígitos (MX) o formato E.164 (+52...)');
  }
  return e164;
}

/** Mapea violaciones de unique (23505) de Postgres a 409 con mensaje claro; re-lanza el resto. */
function rethrowUnique(e: any): never {
  if (e?.code === '23505') {
    const c = String(e.constraint || '');
    if (c.includes('whatsapp')) throw new ConflictException('Ese número de WhatsApp ya está registrado en otro cliente.');
    if (c.includes('store')) throw new ConflictException('Esa tienda ya tiene un cliente vinculado.');
    if (c.includes('code')) throw new ConflictException('Ya existe un cliente con ese código.');
    throw new ConflictException('Valor duplicado (violación de unicidad).');
  }
  throw e;
}

@Injectable()
export class CommercialCustomersService implements CustomerProvisioningPort {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Devuelve el customer linkeado al user del JWT actual via `users.customer_id`.
   * Usado por el Portal B2B (`/customers/me`) para resolver "mi customer" sin
   * depender del orden del listado. Si el user no tiene `customer_id` linkeado,
   * retorna null (ej. superadmin viendo el portal en modo admin).
   */
  async findMine() {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return null;
    return this.tk.run(async (trx) => {
      const userRow = await trx('public.users')
        .where({ id: userId })
        .select('customer_id')
        .first();
      if (!userRow?.customer_id) return null;
      const customer = await trx('commercial.customers')
        .where({ id: userRow.customer_id })
        .whereNull('deleted_at')
        .first();
      return customer || null;
    });
  }

  async create(dto: CreateCustomerDto) {
    this.validateCreate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.customers')
        .where({ code: dto.code })
        .first();
      if (existing) {
        throw new ConflictException(`Ya existe customer con code "${dto.code}"`);
      }

      const [row] = await trx('commercial.customers')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code: dto.code,
          name: dto.name.trim(),
          legal_name: dto.legal_name?.trim() || null,
          rfc: dto.rfc?.toUpperCase() || null,
          email: dto.email?.toLowerCase() || null,
          phone: dto.phone || null,
          whatsapp: normalizeWhatsapp(dto.whatsapp),
          sales_route: dto.sales_route?.trim().toUpperCase() || null,
          billing_address: dto.billing_address
            ? JSON.stringify(dto.billing_address)
            : null,
          shipping_address: dto.shipping_address
            ? JSON.stringify(dto.shipping_address)
            : null,
          store_id: dto.store_id || null,
          default_price_list_id: dto.default_price_list_id || null,
          route_id: dto.route_id || null,
          credit_limit: dto.credit_limit ?? 0,
          payment_terms_days: dto.payment_terms_days ?? 0,
          active: dto.active ?? true,
          notes: dto.notes || null,
        })
        .returning('*')
        .catch(rethrowUnique);

      return row;
    });
  }

  async list(query: ListCustomersQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      // Defense in depth: customer_b2b solo puede listar SU propio customer.
      // Sin esto, un customer_b2b autenticado vería el directorio completo de
      // clientes del tenant (info competitivamente sensible: RFC, email, teléfono,
      // credit limit). RLS no diferencia entre customers del mismo tenant.
      const ctx = this.tenantCtx.get();
      let forceCustomerId: string | null = null;
      if (ctx?.roleName === 'customer_b2b') {
        const userRow = await trx('public.users')
          .where({ id: ctx.userId })
          .select('customer_id')
          .first();
        forceCustomerId = userRow?.customer_id || null;
        if (!forceCustomerId) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
      }

      let q = trx('commercial.customers as c')
        .leftJoin('logistics.routes as r', 'r.id', 'c.route_id')
        .whereNull('c.deleted_at');

      if (forceCustomerId) {
        q = q.where('c.id', forceCustomerId);
      }

      if (typeof query.active === 'boolean') {
        q = q.where('c.active', query.active);
      }
      if (query.search?.trim()) {
        const term = `%${query.search.trim()}%`;
        q = q.where((b) =>
          b
            .where('c.name', 'ilike', term)
            .orWhere('c.code', 'ilike', term)
            .orWhere('c.rfc', 'ilike', term)
            .orWhere('c.email', 'ilike', term),
        );
      }
      // Cartera del vendedor: clientes en las sales_route asignadas al user del
      // JWT. No aplica a customer_b2b (ya quedó forzado a su propio customer).
      if (query.mine && !forceCustomerId) {
        const meId = ctx?.userId || null;
        q = q.whereRaw(vendorTodayRouteExistsSql('c'), [meId]);
      }

      const [{ count }] = await q.clone().count<{ count: string }[]>('c.id as count');
      const total = Number(count) || 0;

      // En modo cartera el orden es la secuencia de visita (nulls al final);
      // fuera de cartera, alfabético por nombre.
      if (query.mine && !forceCustomerId) {
        q = q.orderByRaw('c.visit_sequence asc nulls last').orderBy('c.name', 'asc');
      } else {
        q = q.orderBy('c.name', 'asc');
      }

      const data = await q
        .limit(pageSize)
        .offset(offset)
        .select(
          'c.*',
          'r.name as route_name',
          // Username del Portal B2B enlazado (o null si no tiene acceso). El
          // índice (tenant_id, customer_id) en public.users lo hace barato.
          trx.raw(
            `(select u.username from public.users u
                where u.customer_id = c.id and u.role_name = 'customer_b2b'
                limit 1) as portal_username`,
          ),
        );

      return {
        data,
        page,
        pageSize,
        total,
        pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) || 0 },
      };
    });
  }

  /** Altas de clientes por día (TZ MX) en la ventana. Para mini-charts del KPI strip. */
  async newDaily(days = 30): Promise<Array<{ day: string; count: number }>> {
    const windowDays = Math.min(Math.max(days, 1), 365);
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.customers')
        .whereNull('deleted_at')
        .whereRaw(`created_at >= NOW() - (? || ' days')::interval`, [windowDays])
        .select(
          trx.raw(`DATE_TRUNC('day', created_at AT TIME ZONE 'America/Mexico_City')::date as day`),
          trx.raw('COUNT(*)::int as count'),
        )
        .groupByRaw(`DATE_TRUNC('day', created_at AT TIME ZONE 'America/Mexico_City')`)
        .orderBy('day', 'asc');
      return rows.map((r: any) => ({ day: r.day, count: Number(r.count) }));
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      // Ownership: customer_b2b solo puede leer SU propio customer.
      const ctx = this.tenantCtx.get();
      if (ctx?.roleName === 'customer_b2b') {
        const userRow = await trx('public.users')
          .where({ id: ctx.userId })
          .select('customer_id')
          .first();
        if (!userRow?.customer_id) {
          throw new ForbiddenException('Usuario customer_b2b sin customer_id linkeado');
        }
        if (userRow.customer_id !== id) {
          throw new ForbiddenException('No tenés acceso a este customer');
        }
      }

      const row = await trx('commercial.customers as c')
        .leftJoin('logistics.routes as r', 'r.id', 'c.route_id')
        .where('c.id', id)
        .whereNull('c.deleted_at')
        .first('c.*', 'r.name as route_name');
      if (!row) throw new NotFoundException(`Customer ${id} no encontrado`);
      return row;
    });
  }

  async update(id: string, dto: UpdateCustomerDto) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    this.validateUpdate(dto);

    return this.tk.run(async (trx) => {
      const existing = await trx('commercial.customers')
        .where({ id })
        .whereNull('deleted_at')
        .first();
      if (!existing) throw new NotFoundException(`Customer ${id} no encontrado`);

      if (dto.code && dto.code !== existing.code) {
        const dup = await trx('commercial.customers')
          .where({ code: dto.code })
          .whereNot({ id })
          .first();
        if (dup) throw new ConflictException(`Ya existe customer con code "${dto.code}"`);
      }

      const patch: Record<string, any> = { updated_at: trx.fn.now() };
      if (dto.code !== undefined) patch.code = dto.code;
      if (dto.name !== undefined) patch.name = dto.name.trim();
      if (dto.legal_name !== undefined)
        patch.legal_name = dto.legal_name?.trim() || null;
      if (dto.rfc !== undefined) patch.rfc = dto.rfc?.toUpperCase() || null;
      if (dto.email !== undefined) patch.email = dto.email?.toLowerCase() || null;
      if (dto.phone !== undefined) patch.phone = dto.phone || null;
      if (dto.whatsapp !== undefined) patch.whatsapp = normalizeWhatsapp(dto.whatsapp);
      if (dto.sales_route !== undefined)
        patch.sales_route = dto.sales_route?.trim().toUpperCase() || null;
      if (dto.billing_address !== undefined)
        patch.billing_address = dto.billing_address
          ? JSON.stringify(dto.billing_address)
          : null;
      if (dto.shipping_address !== undefined)
        patch.shipping_address = dto.shipping_address
          ? JSON.stringify(dto.shipping_address)
          : null;
      if (dto.store_id !== undefined) {
        const nextStore = dto.store_id || null;
        if (existing.store_id && nextStore !== existing.store_id) {
          throw new BadRequestException(
            'store_id es inmutable: el vínculo tienda↔cliente se fija al alta de la tienda; no se cambia ni se quita desde aquí.',
          );
        }
        patch.store_id = nextStore;
      }
      if (dto.default_price_list_id !== undefined)
        patch.default_price_list_id = dto.default_price_list_id || null;
      if (dto.route_id !== undefined) patch.route_id = dto.route_id || null;
      if (dto.credit_limit !== undefined) patch.credit_limit = dto.credit_limit;
      if (dto.payment_terms_days !== undefined)
        patch.payment_terms_days = dto.payment_terms_days;
      if (dto.active !== undefined) patch.active = dto.active;
      if (dto.notes !== undefined) patch.notes = dto.notes || null;

      const [row] = await trx('commercial.customers')
        .where({ id })
        .update(patch)
        .returning('*')
        .catch(rethrowUnique);
      return row;
    });
  }

  async softDelete(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.customers')
        .where({ id })
        .whereNull('deleted_at')
        .update({
          deleted_at: trx.fn.now(),
          active: false,
        })
        .returning('id');
      if (!row) throw new NotFoundException(`Customer ${id} no encontrado`);

      // Desactivar el acceso al Portal B2B enlazado (si lo hay). Sin esto, el
      // usuario customer_b2b quedaba activo apuntando a un cliente soft-deleted:
      // podía loguear pero /customers/me devolvía null (filtra deleted_at) →
      // login huérfano en estado roto. La FK es ON DELETE SET NULL, pero el soft-
      // delete no dispara el FK, así que lo desactivamos explícitamente acá.
      const disabled = await trx('public.users')
        .where({ customer_id: id, activo: true })
        .update({ activo: false });

      return { deleted: true, id, portal_logins_disabled: disabled };
    });
  }

  /**
   * J.6.2 — Promueve una tienda de Trade Marketing (`public.stores`) a cliente
   * comercial (`commercial.customers`). Vincula via `customers.store_id`.
   *
   * Idempotente: si ya existe un customer con `store_id = X`, lo retorna.
   * Falla si no hay default price_list y no se especifica uno explícito.
   *
   * Sugerencias: `code` default = `STR-{first 8 chars del UUID del store}`.
   */
  async createFromStore(dto: {
    store_id: string;
    code?: string;
    name?: string;
    default_price_list_id?: string;
    credit_limit?: number;
  }) {
    if (!dto.store_id || !UUID_REGEX.test(dto.store_id)) {
      throw new BadRequestException('store_id requerido (UUID)');
    }

    return this.tk.run(async (trx) => {
      // 1. Verificar que el store existe y es del tenant (RLS lo filtra)
      const store = await trx('public.stores').where({ id: dto.store_id }).first();
      if (!store) throw new NotFoundException(`Store ${dto.store_id} no encontrado`);

      // 2. Idempotencia: si ya hay customer con este store_id, devolverlo
      const existing = await trx('commercial.customers')
        .where({ store_id: dto.store_id })
        .whereNull('deleted_at')
        .first();
      if (existing) {
        return { customer: existing, created: false, message: 'Ya existía customer para este store' };
      }

      // 3. Resolver price_list: explícito > default del tenant
      let priceListId = dto.default_price_list_id || null;
      if (!priceListId) {
        const defaultPl = await trx('commercial.price_lists')
          .where({ is_default: true, active: true })
          .whereNull('deleted_at')
          .first();
        priceListId = defaultPl?.id || null;
      }
      if (!priceListId) {
        throw new ConflictException(
          'No hay default price_list configurado. Crear uno marcado is_default=true antes de promover stores.',
        );
      }

      // 4. Generar code default si no viene
      const code = dto.code || `STR-${dto.store_id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      if (!CODE_REGEX.test(code)) {
        throw new BadRequestException(`code generado/dado inválido: "${code}". Debe matchear [A-Z0-9_-]{2,50}.`);
      }

      const dup = await trx('commercial.customers').where({ code }).first();
      if (dup) throw new ConflictException(`Ya existe customer con code "${code}"`);

      // 5. Crear customer vinculado al store
      const [row] = await trx('commercial.customers')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          code,
          name: (dto.name || store.nombre || `Tienda ${code}`).trim(),
          store_id: dto.store_id,
          default_price_list_id: priceListId,
          credit_limit: dto.credit_limit ?? 0,
          payment_terms_days: 0, // cash-only beta
          active: true,
          notes: `Customer auto-generado desde store "${store.nombre || dto.store_id}" via J.6.2.`,
        })
        .returning('*');

      return { customer: row, created: true, message: 'Customer creado y vinculado al store' };
    });
  }

  /**
   * Port CustomerProvisioning (inversión de dependencia): provisiona el cliente
   * de una tienda al darla de alta en Trade. Delega en createFromStore (idempotente).
   */
  async ensureCustomerForStore(storeId: string) {
    return this.createFromStore({ store_id: storeId });
  }

  /**
   * J.6.3 — Crea user Portal B2B vinculado al customer.
   *
   * - Username default: `cliente_{slug del NOMBRE}` (ej. "Abarrotes Doña Lupita"
   *   → `cliente_abarrotes_dona_lupita`), con sufijo numérico ante colisión.
   *   El admin puede override pasando `dto.username`.
   * - Password default: random 8 chars URL-safe (devuelto UNA SOLA VEZ en el
   *   response, NUNCA persistido en plano).
   * - role_name: `customer_b2b` (debe existir en role_permissions del tenant).
   * - Idempotencia: unique índex `(tenant_id, customer_id) WHERE customer_id IS NOT NULL`
   *   rechaza el INSERT si ya hay user para este customer → 409 Conflict.
   *
   * Returns: `{ username, temporary_password, user_id }`. El password se
   * muestra una sola vez al admin — debe copiarlo y entregarlo al cliente.
   */
  async createPortalAccess(
    customerId: string,
    dto: { username?: string; password?: string } = {},
  ) {
    if (!UUID_REGEX.test(customerId)) {
      throw new BadRequestException('customerId inválido');
    }

    return this.tk.run(async (trx) => {
      // 1. Verificar customer existe + activo
      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer) throw new NotFoundException(`Customer ${customerId} no encontrado`);
      if (!customer.active) {
        throw new ConflictException(`Customer ${customer.code} está inactivo, no se puede crear acceso`);
      }

      // 2. Verificar que el rol customer_b2b existe en este tenant
      const role = await trx('public.role_permissions')
        .where({ role_name: 'customer_b2b' })
        .first();
      if (!role) {
        throw new ConflictException(
          'El rol "customer_b2b" no existe en este tenant. Crear el rol primero en /admin/roles.',
        );
      }

      // 3. Validar idempotencia: hay ya user con customer_id = X?
      const dup = await trx('public.users').where({ customer_id: customerId }).first();
      if (dup) {
        throw new ConflictException(
          `Ya existe acceso Portal B2B para este customer (username: ${dup.username}). Si olvidó el password, resetearlo desde /admin/users.`,
        );
      }

      // 4. Generar username + password.
      // Si el admin NO especifica username, lo derivamos del NOMBRE del cliente:
      //   "Abarrotes Doña Lupita" → "cliente_abarrotes_dona_lupita"
      // resolviendo colisiones con sufijo numérico (_2, _3, …). Un username
      // explícito se respeta tal cual y choca con 409 si ya existe.
      let username: string;
      if (dto.username) {
        username = dto.username.trim();
        if (!/^[a-z0-9_-]{3,50}$/i.test(username)) {
          throw new BadRequestException(
            `username inválido: "${username}". Debe matchear [a-z0-9_-]{3,50}.`,
          );
        }
        const usernameDup = await trx('public.users').where({ username }).first();
        if (usernameDup) {
          throw new ConflictException(`Username "${username}" ya está en uso. Especificar otro.`);
        }
      } else {
        // slug: sin acentos, minúsculas, no-alfanumérico → "_", bordes limpios.
        // Tope 38 para dejar margen a "cliente_" (8) + sufijo "_NNN" dentro de 50.
        const slugify = (s: string) =>
          (s || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 38)
            .replace(/_+$/, '');
        const base = slugify(customer.name) || slugify(customer.code) || 'cliente';
        const root = `cliente_${base}`;
        username = root;
        for (let n = 2; n <= 999; n++) {
          const taken = await trx('public.users').where({ username }).first();
          if (!taken) break;
          username = `${root}_${n}`;
        }
      }

      const temporaryPassword =
        dto.password || randomBytes(6).toString('base64url').slice(0, 8);
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);

      // 5. Insertar user
      const [user] = await trx('public.users')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          username,
          password_hash: passwordHash,
          role_name: 'customer_b2b',
          customer_id: customerId,
          activo: true,
        })
        .returning(['id', 'username']);

      return {
        user_id: user.id,
        username: user.username,
        temporary_password: temporaryPassword,
        message: 'Acceso B2B creado. Copiar password ahora — no se mostrará de nuevo.',
      };
    });
  }

  /**
   * J.6.3b — Resetea el password del acceso Portal B2B de un cliente. Útil cuando
   * el cliente perdió la contraseña (la original solo se muestra una vez). Genera
   * una nueva temporal (devuelta UNA SOLA VEZ), la hashea y reactiva el usuario.
   * Mismo patrón one-time-reveal que createPortalAccess.
   */
  async resetPortalPassword(customerId: string, dto: { password?: string } = {}) {
    if (!UUID_REGEX.test(customerId)) {
      throw new BadRequestException('customerId inválido');
    }

    return this.tk.run(async (trx) => {
      const user = await trx('public.users')
        .where({ customer_id: customerId, role_name: 'customer_b2b' })
        .first();
      if (!user) {
        throw new NotFoundException(
          'Este cliente no tiene acceso al Portal B2B. Usá "Crear acceso" primero.',
        );
      }

      if (dto.password && !/.{4,}/.test(dto.password)) {
        throw new BadRequestException('El password debe tener al menos 4 caracteres.');
      }
      const temporaryPassword =
        dto.password || randomBytes(6).toString('base64url').slice(0, 8);
      const passwordHash = await bcrypt.hash(temporaryPassword, 10);

      // Reactivamos por si el usuario había quedado desactivado (ej. el cliente
      // estuvo soft-deleted y luego se reactivó).
      await trx('public.users')
        .where({ id: user.id })
        .update({ password_hash: passwordHash, activo: true });

      return {
        user_id: user.id,
        username: user.username,
        temporary_password: temporaryPassword,
        message: 'Password reseteado. Copiarlo ahora — no se mostrará de nuevo.',
      };
    });
  }

  // ─────────── validaciones ───────────

  private validateCreate(dto: CreateCustomerDto): void {
    if (!dto.code || !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException(
        'code requerido: 2-50 chars [A-Z0-9_-]. Ej: "MD-0001".',
      );
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('name requerido');
    }
    this.validateOptionalFields(dto);
  }

  private validateUpdate(dto: UpdateCustomerDto): void {
    if (dto.code !== undefined && !CODE_REGEX.test(dto.code)) {
      throw new BadRequestException('code inválido: 2-50 chars [A-Z0-9_-]');
    }
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException('name no puede ser vacío');
    }
    this.validateOptionalFields(dto);
  }

  private validateOptionalFields(dto: UpdateCustomerDto): void {
    if (dto.rfc && !RFC_REGEX.test(dto.rfc.toUpperCase())) {
      throw new BadRequestException(
        'rfc inválido (formato MX: 3-4 letras + 6 dígitos + 3 alfanuméricos)',
      );
    }
    if (dto.store_id && !UUID_REGEX.test(dto.store_id)) {
      throw new BadRequestException('store_id inválido (UUID)');
    }
    if (dto.default_price_list_id && !UUID_REGEX.test(dto.default_price_list_id)) {
      throw new BadRequestException('default_price_list_id inválido (UUID)');
    }
    if (dto.route_id && !UUID_REGEX.test(dto.route_id)) {
      throw new BadRequestException('route_id inválido (UUID)');
    }
    if (
      dto.credit_limit !== undefined &&
      (typeof dto.credit_limit !== 'number' || dto.credit_limit < 0)
    ) {
      throw new BadRequestException('credit_limit debe ser número >= 0');
    }
    if (
      dto.payment_terms_days !== undefined &&
      (!Number.isInteger(dto.payment_terms_days) || dto.payment_terms_days < 0)
    ) {
      throw new BadRequestException('payment_terms_days debe ser entero >= 0');
    }
    if (dto.billing_address) {
      const r = validateJsonb(AddressJsonbSchema, dto.billing_address);
      if (!r.ok)
        throw new BadRequestException(
          `billing_address inválido: ${r.errors.join('; ')}`,
        );
    }
    if (dto.shipping_address) {
      const r = validateJsonb(AddressJsonbSchema, dto.shipping_address);
      if (!r.ok)
        throw new BadRequestException(
          `shipping_address inválido: ${r.errors.join('; ')}`,
        );
    }
  }
}
