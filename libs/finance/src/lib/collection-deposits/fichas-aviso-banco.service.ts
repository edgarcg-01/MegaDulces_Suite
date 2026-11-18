import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CANAL_BANCOS } from '../bank/aviso-bancos';
import { CobranzaGateway } from './cobranza.gateway';

/** Colapsa la ráfaga de avisos de una carga (varias cuentas, varios periodos) en un solo «recarga». */
export const FICHAS_AVISO_RAFAGA_MS = 2_000;
/** Margen sobre la espera de la conciliación (CB.53) para la segunda mirada. */
export const FICHAS_AVISO_MARGEN_MS = 30_000;

/**
 * `[CC.21]` **La bandeja de «Fichas de clientes» se entera cuando llega el estado de cuenta.**
 *
 * El veredicto de cada ficha («entró al banco», «no aparece») se deriva al leer (`ficha-en-banco.ts`), así que lo
 * único que faltaba era que la pantalla abierta volviera a leer cuando cambia el banco. Bancos ya avisa por Postgres:
 * la carga del libro y la descarga del banco emiten `pg_notify('bancos_movimientos')` dentro de su transacción
 * (`aviso-bancos.ts`, CB.60b). Aquí sólo se escucha ese canal y se reenvía «volvé a cargar» por el socket de Cobranza.
 *
 * ── Dos miradas por aviso, y por qué ────────────────────────────────────────────────────────────────────────────
 *  1. **Al llegar** (colapsada en 2 s): el abono ya está — una ficha pasa de «aún no se puede
 *     revisar» a «entró al banco» o a «no aparece».
 *  2. **Cuando la conciliación ya debió correr** (su espera, `BANK_RECON_AVISO_QUIET_S`, más un margen): la
 *     conciliación corre en el worker 60 s después del MISMO aviso y es la que liga el abono a su cobro de Kepler; ahí
 *     una ficha pasa de «sin cobro en Kepler» a «Kepler ya la aplicó».
 * ⛔ No se escucha la tabla de la conciliación: escribe en ráfagas que no tienen que ver con la llegada del banco
 * (medido el 2026-11-17: 29,400 altas en 9 minutos, a las 14 y 16 h, NINGUNA de un abono recién cargado — ese día no
 * entró estado de cuenta; y 0 altas en 3 minutos sin dato nuevo, que es el control de CB.74). Avisaría por
 * re-evaluaciones de periodos viejos, no por depósitos nuevos.
 *
 * ── Dónde escucha ───────────────────────────────────────────────────────────────────────────────────────────────
 * En el **API**, no en el worker: los navegadores están conectados al API, y el worker no tiene adaptador de Redis
 * para alcanzarlos. Con varios pods del API cada uno avisa a SUS sockets (`avisarATodosLocal`).
 *
 * ── Lo que no garantiza ─────────────────────────────────────────────────────────────────────────────────────────
 * `NOTIFY` no se guarda: si el API estaba reiniciando cuando se subió el estado de cuenta, la pantalla abierta no se
 * entera; la siguiente lectura (abrir la vista, cambiar de pestaña, cualquier otro aviso) ya trae el veredicto nuevo,
 * porque nada de esto se guarda. Una ficha cuyo cobro captura Cobranza en Kepler DESPUÉS (sin estado de cuenta nuevo)
 * cambia de veredicto al recargar. Se apaga con `DISABLE_FICHAS_AVISO_BANCO=true`.
 */
@Injectable()
export class FichasAvisoBancoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FichasAvisoBancoService.name);
  private dejarDeEscuchar: (() => void) | null = null;
  private inmediato: NodeJS.Timeout | null = null;
  private tardio: NodeJS.Timeout | null = null;
  /** Para el log y la prueba: cuántos «recarga» salieron. */
  avisosEnviados = 0;

  constructor(
    private readonly listen: PgListenService,
    @Optional() private readonly gateway?: CobranzaGateway,
  ) {}

  /** La espera de la conciliación (la misma variable que lee `BankReconPorAvisoService`) más el margen. */
  get segundaMiradaMs(): number {
    const v = Number(String(process.env.BANK_RECON_AVISO_QUIET_S ?? '').trim());
    const quiet = Number.isFinite(v) && v > 0 ? Math.min(v, 600) * 1000 : 60_000;
    return quiet + FICHAS_AVISO_MARGEN_MS;
  }

  onModuleInit(): void {
    if (process.env.WORKER === 'true') {
      this.logger.log(`no escucho ${CANAL_BANCOS}: este proceso es el worker y las bandejas están conectadas al API`);
      return;
    }
    if (process.env.DISABLE_FICHAS_AVISO_BANCO === 'true') {
      this.logger.log(`apagado (DISABLE_FICHAS_AVISO_BANCO=true): la bandeja de fichas no se refresca al llegar el banco`);
      return;
    }
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_BANCOS, () => this.alAviso());
      this.logger.log(`escuchando ${CANAL_BANCOS}: la bandeja de fichas se refresca al llegar el estado de cuenta`);
    } catch (e: unknown) {
      // No tumba el arranque: sin aviso, la bandeja sigue correcta al recargar. Se DICE.
      this.logger.warn(`no se pudo escuchar ${CANAL_BANCOS}: ${(e as Error)?.message} — la bandeja sólo se actualiza al recargar`);
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    if (this.inmediato) clearTimeout(this.inmediato);
    if (this.tardio) clearTimeout(this.tardio);
    this.inmediato = this.tardio = null;
  }

  /** Un aviso de Bancos. Diez avisos seguidos siguen siendo una mirada inmediata y una tardía. */
  alAviso(): void {
    if (!this.inmediato) {
      this.inmediato = setTimeout(() => { this.inmediato = null; this.enviar('llegó el estado de cuenta'); }, FICHAS_AVISO_RAFAGA_MS);
      this.inmediato.unref?.();
    }
    // La conciliación espera desde el PRIMER aviso y no reinicia su reloj; la segunda mirada tampoco.
    if (!this.tardio) {
      this.tardio = setTimeout(() => { this.tardio = null; this.enviar('la conciliación ya corrió'); }, this.segundaMiradaMs);
      this.tardio.unref?.();
    }
  }

  private enviar(motivo: string): void {
    try {
      const n = this.gateway?.avisarATodosLocal('bank_loaded', motivo) ?? 0;
      this.avisosEnviados++;
      this.logger.log(`bandeja de fichas: «recarga» (${motivo}) a ${n} conexión(es)`);
    } catch (e: unknown) {
      this.logger.warn(`no se pudo avisar a la bandeja: ${(e as Error)?.message}`);
    }
  }
}
