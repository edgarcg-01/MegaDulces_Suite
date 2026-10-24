import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  FIRMA_VIDA_MS,
  textoFalloFirma,
  type ContextoFirma,
  type FalloFirmaSolicitud,
  type FirmaSolicitudAbierta,
  type FirmaSolicitudEstado,
  type FirmaSolicitudTelefono,
} from '@megadulces/contracts';
import {
  decidirCancelar, decidirFirmar, decidirTomar, decidirUsar, estadoVigente, statusDeFallo, telefonoValido,
  type FilaFirma,
} from './caja-firma-solicitud.engine';
import { revisarFirma } from './caja-firma.engine';
import { CajaGateway } from './caja.gateway';

/**
 * ⭐⭐ `[CG.201]` **La firma por teléfono, por HTTP y con la fila como autoridad.**
 *
 * Reemplaza al emparejamiento por socket (`[CG.68]`–`[CG.196]`). Lo que cambia, y por qué:
 *
 *   · **El pedido vive en `finance.cash_signature_requests`**, no en la memoria del socket de la
 *     PC. Un despliegue (11 en 4 días, medido el 2026-10-23), el wifi o una pestaña en segundo
 *     plano ya no lo matan.
 *   · **El teléfono habla por HTTP**, que se reintenta solo y contesta con un código por causa.
 *     Un `emit` sin acuse no decía si llegó.
 *   · **La PC repasa la fila** (`estado`). El aviso por socket (`firma:lista`) sólo ADELANTA el
 *     repaso: si se pierde, la firma aparece igual en el siguiente.
 *   · **El token del QR es un JWT con el id y el tenant**; la autoridad es la fila (estado y
 *     `expira_at`), releída en cada uso. Molde de `[GX.9]` (`expense-capture-links.service.ts`).
 *
 * ⛔ La superficie pública (el teléfono) sólo puede: ver los cuatro datos del contexto y mandar
 *    UN trazo para ESE pedido. No lista nada, no pide pedidos, no ve la caja.
 */
export const CLAVE_TOKEN_FIRMA = 'caja_firma';

interface TokenFirma { readonly t: string; readonly sid: string; readonly tenant_id: string }

const COLS = ['id', 'tipo', 'monto', 'contexto', 'estado', 'expira_at', 'telefono_id',
  'firma_png', 'firma_nombre', 'firmada_at', 'usada_en'] as const;

interface FilaDb extends FilaFirma {
  readonly id: string;
  readonly contexto: ContextoFirma;
  readonly firma_png: string | null;
  readonly firma_nombre: string | null;
  readonly firmada_at: Date | string | null;
  readonly usada_en: string | null;
}

/** El fallo como excepción HTTP: `{ fallo }` en el cuerpo, que es lo que lee el cliente. */
export function falloFirma(f: FalloFirmaSolicitud): HttpException {
  return new HttpException({ fallo: f, message: textoFalloFirma(f) }, statusDeFallo(f));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function leerConCandado(trx: Knex.Transaction, id: string): Promise<FilaDb | null> {
  if (!UUID.test(id)) return null;
  const r = await trx('finance.cash_signature_requests').where({ id }).forUpdate().first(...COLS);
  return (r as FilaDb | undefined) ?? null;
}

/**
 * `[CG.202]` **El movimiento toma la firma de la FILA, no de lo que mande la PC.** Se llama dentro
 * de la transacción del alta del movimiento, con candado: dos guardados simultáneos con el mismo
 * pedido no pueden usarlo los dos.
 */
export async function tomarFirmaParaMovimiento(
  trx: Knex.Transaction, solicitudId: string, tipo: string, monto: number,
): Promise<{ png: string; nombre: string | null }> {
  const fila = await leerConCandado(trx, solicitudId);
  const d = decidirUsar(fila, tipo, monto);
  if (!d.ok) throw falloFirma(d.fallo);
  // `decidirUsar` exige `firmada`, y el CHECK de la tabla exige imagen en `firmada`.
  return { png: String(fila!.firma_png), nombre: fila!.firma_nombre };
}

/** Marca el pedido como usado por ese movimiento. Misma transacción que el alta. */
export async function marcarFirmaUsada(
  trx: Knex.Transaction, solicitudId: string, ledgerId: string, userId: string | null,
): Promise<void> {
  await trx('finance.cash_signature_requests').where({ id: solicitudId, estado: 'firmada' }).update({
    estado: 'usada', usada_en: ledgerId, usada_at: trx.fn.now(), updated_by: userId, updated_at: trx.fn.now(),
  });
}

@Injectable()
export class CajaFirmaService {
  private readonly logger = new Logger(CajaFirmaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: JwtService,
    @Optional() private readonly gateway?: CajaGateway,
  ) {}

  // ══ La PC (con sesión y GESTIONAR) ══════════════════════════════════════════════════════

  /** La PC pide la firma. Devuelve el token que va dentro del QR. */
  async abrir(ctx: ContextoFirma, user: { id?: string; username?: string }): Promise<FirmaSolicitudAbierta> {
    const tenantId = this.tenantCtx.requireTenantId();
    // ⚠️ Sólo los cuatro campos, recortados: la PC no puede empujarle al teléfono otra cosa.
    const limpio: ContextoFirma = {
      tipo: String(ctx?.tipo ?? '').slice(0, 30),
      monto: Math.round((Number(ctx?.monto) || 0) * 100) / 100,
      beneficiario: ctx?.beneficiario ? String(ctx.beneficiario).slice(0, 120) : null,
      documento: ctx?.documento ? String(ctx.documento).slice(0, 60) : null,
    };
    if (!limpio.tipo || limpio.monto < 0) throw new HttpException({ message: 'contexto de firma inválido' }, 400);
    const expira = new Date(Date.now() + FIRMA_VIDA_MS);
    const [row] = await this.tk.run(tenantId, (trx) => trx('finance.cash_signature_requests').insert({
      tenant_id: tenantId,
      tipo: limpio.tipo,
      monto: limpio.monto,
      contexto: JSON.stringify(limpio),
      estado: 'abierta',
      expira_at: expira,
      created_by: user.id,
      created_by_username: user.username ?? null,
    }).returning(['id', 'expira_at']));
    const token = this.jwt.sign(
      { t: CLAVE_TOKEN_FIRMA, sid: row.id, tenant_id: tenantId } satisfies TokenFirma,
      { expiresIn: Math.floor(FIRMA_VIDA_MS / 1000) },
    );
    return { id: row.id, token, expira_at: new Date(row.expira_at).toISOString() };
  }

  /** Lo que la PC repasa mientras espera. La imagen sólo viaja si ya está firmada. */
  async estado(id: string): Promise<FirmaSolicitudEstado> {
    return this.tk.run(async (trx) => {
      if (!UUID.test(id)) throw falloFirma('no_existe');
      const f = (await trx('finance.cash_signature_requests').where({ id }).first(...COLS)) as FilaDb | undefined;
      if (!f) throw falloFirma('no_existe');
      const e = estadoVigente(f, new Date());
      const conFirma = e === 'firmada' || e === 'usada';
      return {
        id: f.id,
        estado: e,
        monto: Number(f.monto),
        firma_png: conFirma ? f.firma_png : null,
        firma_nombre: conFirma ? f.firma_nombre : null,
        firmada_at: f.firmada_at ? new Date(f.firmada_at).toISOString() : null,
      };
    });
  }

  async cancelar(id: string, user: { id?: string }): Promise<{ ok: true }> {
    return this.tk.run(async (trx) => {
      const f = await leerConCandado(trx, id);
      const d = decidirCancelar(f);
      if (!d.ok) throw falloFirma(d.fallo);
      if (d.accion === 'cancelar') {
        await trx('finance.cash_signature_requests').where({ id }).update({
          estado: 'cancelada', cancelada_at: trx.fn.now(), updated_by: user.id ?? null, updated_at: trx.fn.now(),
        });
      }
      return { ok: true as const };
    });
  }

  // ══ El teléfono (público, con el token del QR) ══════════════════════════════════════════

  /** Verifica el token. Que el JWT sea válido no alcanza: la fila manda, y se relee después. */
  private leerToken(token: string): TokenFirma {
    let p: Partial<TokenFirma> | null = null;
    try { p = this.jwt.verify<TokenFirma>(String(token ?? '')); } catch { p = null; }
    // ⛔ Un JWT de SESIÓN también verifica con este secreto: sin la marca `t`, cualquier token de
    //    usuario pasaría por un pase de firma. Inválido y vencido dicen lo mismo a propósito: los
    //    dos se arreglan pidiendo otro QR.
    if (!p || p.t !== CLAVE_TOKEN_FIRMA || !p.sid || !p.tenant_id) throw falloFirma('no_existe');
    return p as TokenFirma;
  }

  async verPorToken(token: string, telefonoId: string): Promise<FirmaSolicitudTelefono> {
    const t = this.leerToken(token);
    if (!telefonoValido(telefonoId)) throw new HttpException({ message: 'teléfono sin identificador' }, 400);
    return this.tk.run(t.tenant_id, async (trx) => {
      const f = await leerConCandado(trx, t.sid);
      const ahora = new Date();
      const d = decidirTomar(f, telefonoId, ahora);
      if (!d.ok) throw falloFirma(d.fallo);
      if (d.accion === 'tomar') {
        await trx('finance.cash_signature_requests').where({ id: t.sid }).update({
          estado: 'tomada', telefono_id: telefonoId, tomada_at: trx.fn.now(), updated_at: trx.fn.now(),
        });
        this.avisar(t.tenant_id, t.sid);
      }
      return {
        estado: d.accion === 'ver_firmada' ? 'firmada' : 'tomada',
        contexto: f!.contexto,
      };
    });
  }

  /**
   * El teléfono manda el trazo. **Idempotente**: si ya estaba firmada por este teléfono contesta
   * OK sin tocar nada — el reintento de un envío cuyo acuse se perdió no puede convertirse en error.
   */
  async firmarPorToken(
    token: string, telefonoId: string, png: string | null | undefined, nombre: string | null | undefined,
  ): Promise<{ ok: true; repetida: boolean }> {
    const t = this.leerToken(token);
    if (!telefonoValido(telefonoId)) throw new HttpException({ message: 'teléfono sin identificador' }, 400);
    const r = await this.tk.run(t.tenant_id, async (trx) => {
      const f = await leerConCandado(trx, t.sid);
      const revision = revisarFirma(f?.tipo ?? 'gasto', png);
      const d = decidirFirmar(f, telefonoId, !!revision.png, new Date());
      if (!d.ok) {
        // ⚠️ Se deja rastro del fallo en la fila (si existe): es lo que mide si el canal falla.
        if (f) {
          await trx('finance.cash_signature_requests').where({ id: t.sid }).update({
            intentos_envio: trx.raw('intentos_envio + 1'), ultimo_fallo: d.fallo, updated_at: trx.fn.now(),
          });
        }
        return { ok: false as const, fallo: d.fallo, descartada: revision.descartada };
      }
      if (d.accion === 'repetida') return { ok: true as const, repetida: true };
      await trx('finance.cash_signature_requests').where({ id: t.sid }).update({
        estado: 'firmada',
        telefono_id: telefonoId,
        tomada_at: trx.raw('coalesce(tomada_at, now())'),
        firma_png: revision.png,
        firma_nombre: nombre ? String(nombre).trim().slice(0, 120) || null : null,
        firmada_at: trx.fn.now(),
        intentos_envio: trx.raw('intentos_envio + 1'),
        ultimo_fallo: null,
        updated_at: trx.fn.now(),
      });
      return { ok: true as const, repetida: false };
    });
    // `ok` es el discriminante: con `'fallo' in r` TS normaliza la unión y deja `fallo` opcional.
    if (!r.ok) {
      if (r.fallo === 'no_es_firma') this.logger.warn(`[CG.201] firma rechazada (${r.descartada}) · pedido ${t.sid}`);
      // Fuera de la transacción: el rastro del fallo SÍ se confirma, la excepción no lo revierte.
      throw falloFirma(r.fallo);
    }
    if (!r.repetida) this.avisar(t.tenant_id, t.sid);
    return { ok: true, repetida: !!r.repetida };
  }

  /** Adelanta el repaso de la PC. Best-effort: si se pierde, la PC la ve en el siguiente repaso. */
  private avisar(tenantId: string, id: string): void {
    try { this.gateway?.emitFirma(tenantId, id); } catch { /* el repaso garantiza */ }
  }
}
