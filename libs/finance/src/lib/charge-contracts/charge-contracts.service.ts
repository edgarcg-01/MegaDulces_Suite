import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import type {
  CargosSinContratoResponse, ConfirmarContratoCargoBody, ContratoCargo, ContratoCargoEscrito, ContratosCargoResponse, CrearContratoCargoBody,
  DocumentoContratoCargoBody, DocumentoContratoCargoUrl, EditarContratoCargoBody, EstadoContratoCargo, MotivoContratoCargoBody,
  PasadaCargosDelBanco, ResultadoPropuestaContratos, ResumenCargosDelMes,
} from '@megadulces/contracts';
import {
  ErrorDeContrato, cancelarContrato, confirmarContrato, crearContrato, editarPropuesta, guardarDocumento, leerCargosSinContrato,
  leerContratos, llaveDelDocumento, proponerDesdeLaHistoria, terminarContrato,
} from './contratos-de-cargo.sql';
import { cerrarCargosCobrados, generarCargosDelMes, recalcularInteresesDelCredito, retirarCargosTrasElFin } from './cargo-del-mes.sql';

/** Cuántos cargos sin contrato devuelve una página, y el techo que acepta. */
export const SIN_CONTRATO_POR_PAGINA = 200;
export const SIN_CONTRATO_TOPE = 1000;
/** Quién firma lo que hace el sistema solo (proponer, programar y cerrar con cada carga del banco). */
export const AUTOR_CARGOS_DEL_BANCO = 'sistema:cargos-del-banco';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Una fecha AAAA-MM-DD que existe (el 2026-13-01 o el 31 de noviembre no). */
const fechaReal = (f: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T12:00:00Z`))
  && new Date(`${f}T12:00:00Z`).toISOString().slice(0, 10) === f;

/** El primer día del mes anterior a `hoy` (el rango por omisión de «sin contrato»: este mes y el pasado). */
export function inicioDelMesAnterior(hoy: string): string {
  const [a, m] = hoy.slice(0, 7).split('-').map(Number);
  const n = m - 2;
  return `${a + Math.floor(n / 12)}-${String(((n % 12) + 12) % 12 + 1).padStart(2, '0')}-01`;
}

/**
 * `[PGP.213]` C2 — **La API de los contratos que sustentan los cargos del banco** (anexo CR §3.1–§3.4; DCR1 «el sistema
 * propone, Tesorería confirma», DCR2, DCR5, DCR11). Lee y escribe SÓLO por `contratos-de-cargo.sql.ts` y `cargo-del-mes.sql.ts`
 * (regla 14: los caminos que escriben un contrato o su cargo viven allí). Aquí se traduce al HTTP:
 *  · no existe → 404 · el estado no lo permite → 409 · el cuerpo trae algo mal → 400 en llano · falta la migración → 503
 *    («sin medir», nunca una lista vacía que se lea como «no hay contratos»).
 *
 * ⭐ Al CONFIRMAR, el cargo del mes se programa en ese momento (`generarCargosDelMes`), no hasta la siguiente carga del
 * banco. Si eso falla, el contrato queda confirmado igual y la respuesta lo dice (`aviso`): la pasada del worker lo vuelve a
 * intentar con la siguiente carga.
 */
@Injectable()
export class ChargeContractsService {
  private readonly logger = new Logger(ChargeContractsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  async listar(): Promise<ContratosCargoResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const contratos = await this.correr((trx) => leerContratos(trx, tenantId));
    const conteo: Record<EstadoContratoCargo, number> = { propuesto: 0, confirmado: 0, terminado: 0, cancelado: 0 };
    for (const c of contratos) conteo[c.estado]++;
    return { contratos, conteo };
  }

  async sinContrato(q: { desde?: string; hasta?: string; limit?: string | number }): Promise<CargosSinContratoResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const hasta = q.hasta ?? hoy;
    const desde = q.desde ?? inicioDelMesAnterior(hoy);
    if (!fechaReal(desde) || !fechaReal(hasta)) throw new BadRequestException('Las fechas van como AAAA-MM-DD (y tienen que existir).');
    if (hasta < desde) throw new BadRequestException('«hasta» va después de «desde».');
    const pedido = q.limit === undefined || q.limit === '' ? SIN_CONTRATO_POR_PAGINA : Number(q.limit);
    if (!Number.isInteger(pedido) || pedido < 1) throw new BadRequestException('limit va de 1 a ' + SIN_CONTRATO_TOPE + '.');
    const limit = Math.min(pedido, SIN_CONTRATO_TOPE);
    return this.correr((trx) => leerCargosSinContrato(trx, tenantId, desde, hasta, limit));
  }

  /** El sistema propone lo nuevo que ve en el banco (también lo hace solo con cada carga: `CargosDelBancoService`). */
  async proponer(actor: string): Promise<ResultadoPropuestaContratos> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.correr((trx) => proponerDesdeLaHistoria(trx, tenantId, actor));
  }

  async crear(body: CrearContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!body || typeof body !== 'object') throw new BadRequestException('Falta el contrato.');
    if (body.cuenta_id !== undefined && !UUID.test(String(body.cuenta_id))) throw new BadRequestException('La cuenta de cargo no es válida.');
    const id = await this.correr(async (trx) => {
      const cuenta = await trx('finance.bank_accounts').where({ tenant_id: tenantId, id: body.cuenta_id }).first('id');
      if (!cuenta) throw new ErrorDeContrato('invalido', 'La cuenta de cargo no es una cuenta de Mega Dulces.');
      return crearContrato(trx, tenantId, actor, { ...body, renglones: Array.isArray(body.renglones) ? body.renglones : [] });
    });
    return { contrato: await this.uno(id) };
  }

  async editar(id: string, body: EditarContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    if (body?.renglones !== undefined && !Array.isArray(body.renglones)) throw new BadRequestException('Los conceptos van en una lista.');
    await this.correr((trx) => editarPropuesta(trx, tenantId, id, actor, body ?? {}));
    return { contrato: await this.uno(id) };
  }

  async confirmar(id: string, body: ConfirmarContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    // El documento NO viaja aquí (se sube antes con `documento`): `CambiosAlConfirmar.documento` queda fuera a propósito.
    const { tipo, acreedor, referencia, cadencia, dia_desde, dia_hasta, inicio, fin, kepler_acreedor, sucursal, notas } = body ?? {};
    await this.correr((trx) => confirmarContrato(trx, tenantId, id, actor, {
      tipo, acreedor, referencia, cadencia, dia_desde, dia_hasta, inicio, fin, kepler_acreedor, sucursal, notas,
    }));
    let cargos: ResumenCargosDelMes | null = null;
    let aviso: string | null = null;
    try {
      cargos = await this.programarCargosDelMes(tenantId, actor, todayMx());
    } catch (e: unknown) {
      aviso = `Contrato confirmado, pero su cargo del mes no se pudo programar ahora (${(e as Error)?.message}). Se vuelve a intentar con la siguiente carga del banco.`;
      this.logger.error(`confirmar ${id}: ${aviso}`);
    }
    return { contrato: await this.uno(id), cargos, aviso };
  }

  async terminar(id: string, body: MotivoContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    if (body?.fin !== undefined && body.fin !== null && !fechaReal(String(body.fin))) throw new BadRequestException('La fecha de fin va como AAAA-MM-DD.');
    // Terminar y retirar lo programado después del fin, en UNA transacción: o las dos cosas o ninguna.
    const cargos_retirados = await this.correr(async (trx) => {
      await terminarContrato(trx, tenantId, id, actor, String(body?.motivo ?? ''), body?.fin ?? null);
      return retirarCargosTrasElFin(trx, tenantId, id, actor);
    });
    return { contrato: await this.uno(id), cargos_retirados };
  }

  async rechazar(id: string, body: MotivoContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    await this.correr((trx) => cancelarContrato(trx, tenantId, id, actor, String(body?.motivo ?? '')));
    return { contrato: await this.uno(id) };
  }

  /**
   * El PDF del contrato (DCR11). Se revisa el estado ANTES de subir (no se sube un archivo a un contrato que ya no lo
   * lleva) y, si guardar la llave falla, el archivo recién subido se borra: no queda un PDF huérfano en el bucket.
   */
  async subirDocumento(id: string, body: DocumentoContratoCargoBody, actor: string): Promise<ContratoCargoEscrito> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    if (!body?.pdf) throw new BadRequestException('Falta el PDF del contrato.');
    if (!this.storage?.isConfigured()) throw new ServiceUnavailableException('El almacenamiento de archivos no está disponible: no se puede guardar el PDF.');
    const actual = (await this.listar()).contratos.find((c) => c.id === id);
    if (!actual) throw new NotFoundException('Ese contrato no existe.');
    if (actual.estado !== 'propuesto' && actual.estado !== 'confirmado') throw new ConflictException(`El contrato está ${actual.estado === 'cancelado' ? 'rechazado' : actual.estado}: ya no lleva documento.`);
    const subido = await this.storage.putPdf(body.pdf, `finance/${tenantId}/charge-contracts`);
    try {
      await this.correr((trx) => guardarDocumento(trx, tenantId, id, actor, { storage_key: subido.key, nombre: body.nombre }));
    } catch (e) {
      await this.storage.remove(subido.key).catch(() => undefined);
      throw e;
    }
    return { contrato: await this.uno(id) };
  }

  async urlDocumento(id: string): Promise<DocumentoContratoCargoUrl> {
    const tenantId = this.tenantCtx.requireTenantId();
    this.exigirId(id);
    const d = await this.correr((trx) => llaveDelDocumento(trx, tenantId, id));
    if (!d.llave) throw new NotFoundException('Este contrato no tiene PDF todavía.');
    if (!this.storage?.isConfigured()) throw new ServiceUnavailableException('El almacenamiento de archivos no está disponible: no se puede abrir el PDF.');
    return { url: await this.storage.signedUrl(d.llave), nombre: d.nombre };
  }

  /**
   * La pasada de los cargos del banco de UN tenant (el del contexto): proponer lo nuevo → recalcular el interés un día
   * antes (`[PGP.219]`) → programar el cargo de cada mes → cerrar lo que el banco ya cobró (por la liga de `[PGP.212]`).
   * Cada paso en su transacción: si uno falla, los demás corren y `fallas` dice cuál (una pasada a medias no se reporta
   * como completa ni como fallida entera).
   */
  async pasada(actor: string, hoy: string = todayMx()): Promise<PasadaCargosDelBanco> {
    const tenantId = this.tenantCtx.requireTenantId();
    const out: PasadaCargosDelBanco = { hoy, propuesta: null, recalculados: null, cargos: null, cerrados: null, esperando: null, fallas: [] };
    const paso = async <T>(nombre: string, fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch (e: unknown) { out.fallas.push(`${nombre}: ${(e as Error)?.message ?? e}`); return null; }
    };
    out.propuesta = await paso('proponer', () => this.tk.run((trx) => proponerDesdeLaHistoria(trx, tenantId, actor)));
    const recalculo = await paso('recalcular el interés', () => this.tk.run((trx) => recalcularInteresesDelCredito(trx, tenantId, actor, hoy)));
    out.recalculados = recalculo ? recalculo.recalculados.length : null;
    out.cargos = await paso('programar el cargo del mes', () => this.programarCargosDelMes(tenantId, actor, hoy));
    const cierre = await paso('cerrar lo cobrado', () => this.tk.run((trx) => cerrarCargosCobrados(trx, tenantId, actor)));
    out.cerrados = cierre ? cierre.cerrados.length : null;
    out.esperando = cierre ? cierre.esperando.length : null;
    return out;
  }

  private async programarCargosDelMes(tenantId: string, actor: string, hoy: string): Promise<ResumenCargosDelMes> {
    const r = await this.tk.run((trx) => generarCargosDelMes(trx, tenantId, actor, hoy));
    return { generados: r.generados.length, ya_estaban: r.ya_estaban, omitidos: r.omitidos };
  }

  private async uno(id: string): Promise<ContratoCargo> {
    const c = (await this.listar()).contratos.find((x) => x.id === id);
    if (!c) throw new NotFoundException('Ese contrato no existe.');
    return c;
  }

  private exigirId(id: string): void {
    if (!UUID.test(String(id ?? ''))) throw new BadRequestException('id inválido');
  }

  /** Corre en la transacción del tenant y traduce el error del dominio (y los de la base que se escapen) al HTTP. */
  private async correr<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.tk.run(fn);
    } catch (e: unknown) {
      throw aHttp(e);
    }
  }
}

/** El error del dominio o de la base, como excepción HTTP con un mensaje que la persona entiende. */
export function aHttp(e: unknown): unknown {
  if (e instanceof ErrorDeContrato) {
    switch (e.codigo) {
      case 'no_existe': return new NotFoundException(e.message);
      case 'transicion': return new ConflictException(e.message);
      case 'sin_medir': return new ServiceUnavailableException(e.message);
      default: return new BadRequestException(e.message);
    }
  }
  const code = (e as { code?: string } | null)?.code;
  if (code === '23514' || code === '23502' || code === '22P02' || code === '22007' || code === '22008' || code === '22003') {
    return new BadRequestException(`Un dato no es válido para el contrato (${(e as { constraint?: string }).constraint ?? code}).`);
  }
  if (code === '23503') return new BadRequestException('La cuenta o el contrato al que apunta no existe.');
  if (code === '23505') return new ConflictException(`Ya existe (${(e as { constraint?: string }).constraint ?? code}): por ejemplo, dos filas de la tabla con la misma fecha.`);
  return e;
}
