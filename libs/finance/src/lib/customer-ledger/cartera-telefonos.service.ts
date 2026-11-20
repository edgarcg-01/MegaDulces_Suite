import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { KeplerTelefonoClienteAdapter, normalizarTelefono, type ResultadoServidorTelefono } from './kepler-telefono-cliente.adapter';

const TIPO = 'telefono_cliente';
const SUCURSAL = /^[0-9]{2}$/;

/** Lo que la ficha necesita para mostrar y corregir los teléfonos de la cuenta. */
export interface TelefonosCuenta {
  cliente_code: string;
  /** El teléfono del cliente en CADA sucursal donde está dado de alta (`kdud.c7`, por evento desde Kepler). */
  sucursales: { sucursal: string; telefono: string | null }[];
  /** ¿Se puede escribir en Kepler ahora? Si no, por qué (en el orden en que se resuelve). */
  escritura: { posible: boolean; motivo: string | null };
  vendedor: { sucursal: string; code: string; nombre: string | null; telefono: string | null } | null;
  /** `null` = la migración de CXC.48 no está: no se sabe (no es «nunca»). */
  ultimo_cambio: { telefono_nuevo: string; estado: string; created_by: string | null; created_at: string } | null;
}

export interface CambioTelefonoCliente {
  estado: 'escrito' | 'parcial' | 'rechazado';
  servidores: ResultadoServidorTelefono[];
}

/**
 * `[CXC.48]` C1/C2 — Los teléfonos de la cartera (Edgar, 2026-11-20).
 *
 *  · **Cliente** → Kepler (`kdud.c7`) en cada base donde está su clave, por `KeplerTelefonoClienteAdapter`. La persona
 *    queda en `finance.customer_phone_changes` (Kepler sólo verá «SUITE»). El ODS lo trae de vuelta por la cola de
 *    cambios (`kdud` está en `ODS_COLA_TABLES` desde CXC.45): sin importer ni cron.
 *  · **Vendedor** → `commercial.seller_phones`, dato propio de la Suite: `kduv` no tiene una columna de teléfono que se
 *    pueda nombrar sin adivinar (medido: de c8 a c21, vacías en las 400 filas).
 */
@Injectable()
export class CarteraTelefonosService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly kepler: KeplerTelefonoClienteAdapter,
  ) {}

  private static validarCuenta(sucursal: string, cliente: string): { s: string; c: string } {
    const s = (sucursal || '').trim(); const c = (cliente || '').trim();
    if (!SUCURSAL.test(s) || !c) throw new BadRequestException('cuenta inválida');
    return { s, c };
  }

  private async hayTabla(trx: Knex.Transaction, rel: string): Promise<boolean> {
    return (await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [rel])).rows[0]?.ok === true;
  }

  /** Por qué no se puede escribir el teléfono en Kepler desde esta sucursal; `null` = se puede. */
  private async bloqueo(trx: Knex.Transaction, sucursal: string): Promise<string | null> {
    if (!(await this.hayTabla(trx, 'finance.customer_phone_changes'))) return 'Falta aplicar la migración de CXC.48.';
    const sw = (await trx.raw(
      `SELECT encendida, tope_dia FROM commercial.kepler_push_switch
        WHERE tenant_id = public.current_tenant_id() AND sucursal = ? AND tipo = ?`, [sucursal, TIPO])).rows[0];
    if (!sw?.encendida) return 'La escritura del teléfono en Kepler está apagada para esta sucursal.';
    const faltan = this.kepler.faltantes();
    if (faltan.length) return `Faltan conexiones a Kepler (${faltan.length} de 10). Sin las 10 no se escribe en ninguna.`;
    if (sw.tope_dia != null) {
      const { rows: [hoy] } = await trx.raw(
        `SELECT count(*)::int AS n FROM finance.customer_phone_changes
          WHERE sucursal = ? AND estado IN ('escrito', 'parcial')
            AND created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`,
        [sucursal]);
      if (hoy.n >= Number(sw.tope_dia)) return `Hoy ya se cambiaron ${hoy.n} teléfono(s) desde esta sucursal; el tope es ${sw.tope_dia} por día.`;
    }
    return null;
  }

  async ver(sucursal: string, cliente: string, vendedor?: string): Promise<TelefonosCuenta> {
    const { s, c } = CarteraTelefonosService.validarCuenta(sucursal, cliente);
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const sucursales = (await trx.raw(
        `SELECT btrim(sucursal) AS sucursal, NULLIF(btrim(c7), '') AS telefono
           FROM kepler_ods.kdud WHERE btrim(c2) = ? ORDER BY 1`, [c])).rows as { sucursal: string; telefono: string | null }[];
      if (!sucursales.length) throw new NotFoundException(`El cliente ${c} no está dado de alta en ninguna sucursal de Kepler.`);
      const motivo = await this.bloqueo(trx, s);

      let vend: TelefonosCuenta['vendedor'] = null;
      const v = (vendedor || '').trim();
      if (v) {
        const k = (await trx.raw(
          `SELECT NULLIF(btrim(c3), '') AS nombre FROM kepler_ods.kduv WHERE btrim(sucursal) = ? AND btrim(c2) = ? LIMIT 1`, [s, v])).rows[0];
        const tel = (await this.hayTabla(trx, 'commercial.seller_phones'))
          ? (await trx.raw(`SELECT telefono FROM commercial.seller_phones WHERE sucursal = ? AND vendedor_code = ?`, [s, v])).rows[0]?.telefono ?? null
          : null;
        vend = { sucursal: s, code: v, nombre: k?.nombre ?? null, telefono: tel };
      }

      const ultimo = (await this.hayTabla(trx, 'finance.customer_phone_changes'))
        ? (await trx.raw(
            `SELECT telefono_nuevo, estado, created_by, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
               FROM finance.customer_phone_changes WHERE cliente_code = ? ORDER BY created_at DESC LIMIT 1`, [c])).rows[0] ?? null
        : null;
      return { cliente_code: c, sucursales, escritura: { posible: motivo == null, motivo }, vendedor: vend, ultimo_cambio: ultimo };
    });
  }

  /** Escribe el teléfono del cliente en Kepler (cada base donde está su clave). La ESCRITURA sale de la transacción de la Suite. */
  async cambiarCliente(sucursal: string, cliente: string, crudo: string, usuario?: string): Promise<CambioTelefonoCliente> {
    const { s, c } = CarteraTelefonosService.validarCuenta(sucursal, cliente);
    const t = normalizarTelefono(crudo);
    if (!t.ok) throw new BadRequestException(t.motivo);
    this.tenantCtx.requireTenantId();

    // 1. Candados y el renglón «pendiente» (antes de tocar Kepler: si algo se cae a medio camino, queda el rastro).
    const id = await this.tk.run(async (trx) => {
      const motivo = await this.bloqueo(trx, s);
      if (motivo) throw new ConflictException(motivo);
      const anterior = (await trx.raw(
        `SELECT NULLIF(btrim(c7), '') AS t FROM kepler_ods.kdud WHERE btrim(sucursal) = ? AND btrim(c2) = ?`, [s, c])).rows[0];
      if (!anterior) throw new NotFoundException(`El cliente ${c} no está dado de alta en esta sucursal de Kepler.`);
      const [row] = await trx('finance.customer_phone_changes').insert({
        tenant_id: trx.raw('current_tenant_id()'), sucursal: s, cliente_code: c,
        telefono_anterior: anterior.t, telefono_nuevo: t.valor, estado: 'pendiente',
        created_by: usuario || null, updated_by: usuario || null,
      }).returning(['id']);
      return row.id as string;
    });

    // 2. Kepler
    let servidores: ResultadoServidorTelefono[];
    try {
      servidores = await this.kepler.escribir(c, t.valor);
    } catch (err) {
      await this.cerrar(id, 'rechazado', { error: (err as Error).message }, usuario);
      throw new ServiceUnavailableException((err as Error).message);
    }

    // 3. El resultado, en el renglón
    const rechazadas = servidores.filter((x) => x.estado === 'rechazada').length;
    const buenas = servidores.filter((x) => x.estado === 'escrita' || x.estado === 'ya_estaba').length;
    const estado: CambioTelefonoCliente['estado'] = rechazadas === 0 ? 'escrito' : buenas > 0 ? 'parcial' : 'rechazado';
    await this.cerrar(id, estado, { servidores }, usuario);
    return { estado, servidores };
  }

  private async cerrar(id: string, estado: string, resultado: unknown, usuario?: string): Promise<void> {
    await this.tk.run((trx) => trx('finance.customer_phone_changes').where({ id })
      .update({ estado, resultado: JSON.stringify(resultado), updated_by: usuario || null, updated_at: trx.fn.now() }));
  }

  /** El teléfono del vendedor, en la Suite (Kepler no lo guarda). Debe existir en `kduv` de esa sucursal. */
  async cambiarVendedor(sucursal: string, vendedor: string, crudo: string, usuario?: string): Promise<{ sucursal: string; code: string; telefono: string }> {
    const s = (sucursal || '').trim(); const v = (vendedor || '').trim();
    if (!SUCURSAL.test(s) || !v) throw new BadRequestException('vendedor inválido');
    const t = normalizarTelefono(crudo);
    if (!t.ok) throw new BadRequestException(t.motivo);
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.hayTabla(trx, 'commercial.seller_phones'))) throw new ConflictException('Falta aplicar la migración de CXC.48.');
      const k = (await trx.raw(`SELECT 1 FROM kepler_ods.kduv WHERE btrim(sucursal) = ? AND btrim(c2) = ? LIMIT 1`, [s, v])).rows[0];
      if (!k) throw new NotFoundException(`El vendedor ${v} no existe en el catálogo de Kepler de esa sucursal.`);
      await trx.raw(
        `INSERT INTO commercial.seller_phones (tenant_id, sucursal, vendedor_code, telefono, created_by, updated_by)
         VALUES (current_tenant_id(), ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, sucursal, vendedor_code)
         DO UPDATE SET telefono = EXCLUDED.telefono, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [s, v, t.valor, usuario || null, usuario || null]);
      return { sucursal: s, code: v, telefono: t.valor };
    });
  }
}
