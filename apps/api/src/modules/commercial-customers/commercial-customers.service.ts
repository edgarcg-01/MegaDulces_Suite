import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';
import {
  AddressJsonbSchema,
  AddressJsonb,
  validateJsonb,
} from '../../shared/schemas/jsonb-schemas';

export interface CreateCustomerDto {
  code: string;
  name: string;
  legal_name?: string;
  rfc?: string;
  email?: string;
  phone?: string;
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
}

const CODE_REGEX = /^[A-Z0-9_-]{2,50}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC_REGEX = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;

@Injectable()
export class CommercialCustomersService {
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
        .returning('*');

      return row;
    });
  }

  async list(query: ListCustomersQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    return this.tk.run(async (trx) => {
      let q = trx('commercial.customers as c')
        .leftJoin('logistics.routes as r', 'r.id', 'c.route_id')
        .whereNull('c.deleted_at');

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

      const [{ count }] = await q.clone().count<{ count: string }[]>('c.id as count');
      const total = Number(count) || 0;

      const data = await q
        .orderBy('c.name', 'asc')
        .limit(pageSize)
        .offset(offset)
        .select('c.*', 'r.name as route_name');

      return {
        data,
        page,
        pageSize,
        total,
        pagination: { page, pageSize, total, pageCount: Math.ceil(total / pageSize) || 0 },
      };
    });
  }

  async findById(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');

    return this.tk.run(async (trx) => {
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
      if (dto.billing_address !== undefined)
        patch.billing_address = dto.billing_address
          ? JSON.stringify(dto.billing_address)
          : null;
      if (dto.shipping_address !== undefined)
        patch.shipping_address = dto.shipping_address
          ? JSON.stringify(dto.shipping_address)
          : null;
      if (dto.store_id !== undefined) patch.store_id = dto.store_id || null;
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
        .returning('*');
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
      return { deleted: true, id };
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
   * J.6.3 — Crea user Portal B2B vinculado al customer.
   *
   * - Username default: `cliente_{customer.code lowercase}`.
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

      // 4. Generar username + password
      const username = (dto.username || `cliente_${customer.code.toLowerCase()}`).trim();
      if (!/^[a-z0-9_-]{3,50}$/i.test(username)) {
        throw new BadRequestException(
          `username inválido: "${username}". Debe matchear [a-z0-9_-]{3,50}.`,
        );
      }
      const usernameDup = await trx('public.users').where({ username }).first();
      if (usernameDup) {
        throw new ConflictException(`Username "${username}" ya está en uso. Especificar otro.`);
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
