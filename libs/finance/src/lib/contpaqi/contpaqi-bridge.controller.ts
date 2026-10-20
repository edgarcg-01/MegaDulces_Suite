import {
  BadRequestException, Body, ConflictException, Controller, Get, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  ContpaqiArmadoService, EntregaRechazada,
  type PendienteProveedor, type ResumenLote, type ResumenMes,
} from './contpaqi-armado.service';
import { ContpaqiCuadreService } from './contpaqi-cuadre.service';

/**
 * Fase CP `[CP.8.32]` — **La bandeja del puente: qué saldría de póliza, y qué no sale y por qué.**
 *
 * ── Qué muestra, y por qué eso y no otra cosa ───────────────────────────────────────────────
 * El puente **hoy rechaza todo**: las 21 reglas están sin firmar. Una bandeja que sólo listara
 * lo entregado estaría vacía y no serviría de nada.
 *
 * ⭐ Lo que sí tiene valor hoy es **el rechazo con dueño**. Medido en enero: 1,474 movimientos
 * que el diseño viejo habría convertido en 1,474 pólizas se agrupan en **258 lotes**, y los
 * motivos se reparten así:
 *
 *     sin_regla             954   el contador
 *     proveedor_sin_cuenta  216   los 33 alias (compras)
 *     no_aplica             148   ⭐ NADIE: ya se decidió que no genera póliza
 *     sin_centro_costo      135   negocio: CB no trae centro de costo
 *     sin_medir              21   re-correr el derivador con otra ventana
 *
 * **Esa tabla es la entrega.** Antes todo caía en un rechazo genérico y la pantalla habría dicho
 * *"1,474 pendientes"* — un número que no le dice a nadie qué hacer. Ahora cada cubo tiene a quién
 * le toca, y 148 de ellos **no son trabajo pendiente de nadie**.
 *
 * ── Entregar ────────────────────────────────────────────────────────────────────────────────
 * ⭐ `[CP.8.52]` `POST /entregas` existe desde el 2026-10-20 y **no entrega nada**: registra que
 * contabilidad ya cargó el archivo en ContPAQi, para que el cuadre lo busque del otro lado. Sólo
 * acepta el mismo archivo que la Suite genera hoy, byte a byte. Antes no existía a propósito:
 * nunca se había importado un archivo (`[CP.8.24]`), y sigue siendo así hasta la prueba A/B.
 *
 * ⭐ `FISCAL_CONTPAQI_BRIDGE_GESTIONAR` ya estaba repartido: la puerta de marcar está separada de
 * la de mirar.
 *
 * ── Permisos propios ────────────────────────────────────────────────────────────────────────
 * No se heredan del Libro de Compras ni de Contabilidad electrónica. El libro es el trámite
 * **mensual** de compras; esto es el flujo **continuo** de egresos de banco, y quien revisa uno
 * no revisa el otro (mismo criterio que `[LC.6]` aplicó en su momento).
 */
@ApiTags('finance-contpaqi-bridge')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/contpaqi')
export class ContpaqiBridgeController {
  constructor(
    private readonly armado: ContpaqiArmadoService,
    private readonly cuadre: ContpaqiCuadreService,
  ) {}

  /**
   * Los lotes del mes: uno por **(cuenta de banco × día)**, que es el grano real de ContPAQi
   * —medido: 4,067 de 4,457 pólizas de egreso de 2026 tienen UN solo renglón de banco—.
   *
   * ⚠️ Es **simulación y no escribe**. Es lo correcto hasta que haya reglas firmadas: la bandeja
   * tiene que poder mirarse sin que mirar cambie nada.
   */
  @Get('lotes')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_VER)
  @ApiOperation({ summary: 'Los lotes (banco × día) del mes: qué entraría a la póliza y qué no.' })
  async lotes(@Query('mes') mes?: string): Promise<{
    mes: string;
    lotes: ResumenLote[];
    resumen: {
      lotes: number; con_asiento: number; movimientos: number; incluidas: number;
      /** ⭐ El universo del mes: `movimientos + fuera_de_lote`. Ver `fuera_de_lote`. */
      universo: number;
    };
    fuera_de_lote: ResumenMes['fuera_de_lote'];
    motivos: { motivo: string; movimientos: number; dueno: string }[];
  }> {
    const anioMes = /^\d{4}-\d{2}$/.test(String(mes ?? '')) ? String(mes) : mesPorDefecto();
    const { lotes, fuera_de_lote } = await this.armado.simularLotes(anioMes);

    const acc: Record<string, number> = {};
    let movimientos = 0;
    let incluidas = 0;
    for (const l of lotes) {
      movimientos += l.movimientos;
      incluidas += l.incluidas;
      for (const [m, n] of Object.entries(l.motivos)) acc[m] = (acc[m] ?? 0) + n;
    }

    return {
      mes: anioMes,
      lotes,
      resumen: {
        lotes: lotes.length,
        con_asiento: lotes.filter((l) => l.incluidas > 0).length,
        movimientos,
        incluidas,
        universo: movimientos + fuera_de_lote.movimientos,
      },
      fuera_de_lote,
      // ⭐ Ordenado por tamaño: lo primero que se ve es lo que más trabajo representa.
      motivos: Object.entries(acc)
        .sort((a, b) => b[1] - a[1])
        .map(([motivo, n]) => ({ motivo, movimientos: n, dueno: DUENO[motivo] ?? 'sin clasificar' })),
    };
  }

  /**
   * `[CP.8.38]` — **El archivo del mes, para descargar.**
   *
   * ⛔⛔ **Generar no es entregar.** No escribe `contpaqi.poliza_exports`, así que **no arranca el
   * reloj del cuadre**. Marcar entregado al descargar pondría en ese estado a archivos que nadie
   * importó, y el cuadre pasaría a medir cuánta gente apretó un botón.
   *
   * Exige `_GESTIONAR`: producir el artefacto es hacer, no mirar.
   */
  @Get('archivo')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR)
  @ApiOperation({ summary: 'Genera el TXT del mes (una póliza por lote). NO lo marca entregado.' })
  async archivo(@Query('mes') mes: string | undefined, @Res() res: Response) {
    const anioMes = /^\d{4}-\d{2}$/.test(String(mes ?? '')) ? String(mes) : mesPorDefecto();
    let r: Awaited<ReturnType<ContpaqiArmadoService['generarArchivoMes']>>;
    try {
      r = await this.armado.generarArchivoMes(anioMes);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    // `latin1`: el layout es de ancho fijo en bytes, y un acento en UTF-8 ocuparía dos,
    // corriendo todas las columnas del renglón.
    const buf = Buffer.from(r.contenido, 'latin1');
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nombre}"`);
    res.setHeader('X-Polizas', String(r.polizas));
    res.setHeader('X-Movimientos', String(r.movimientos));
    // ⭐ Viaja en la respuesta para que nadie confunda descargar con entregar.
    res.setHeader('X-Entregado', 'false');
    res.send(buf);
  }

  /**
   * `[CP.8.37]` Los nombres del banco que todavía no llegan a una cuenta, por dinero.
   *
   * ⚠️ Va con `_VER` y no con `_GESTIONAR`: **mirar el trabajo pendiente no es hacerlo**, y quien
   * revisa la bandeja tiene que poder ver por qué está trabada sin poder tocarla.
   */
  @Get('proveedores-pendientes')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_VER)
  @ApiOperation({ summary: 'Nombres del banco sin cuenta de proveedor, agrupados y por importe.' })
  async pendientes(@Query('mes') mes?: string): Promise<{ mes: string; total_importe: number; filas: PendienteProveedor[] }> {
    const anioMes = /^\d{4}-\d{2}$/.test(String(mes ?? '')) ? String(mes) : mesPorDefecto();
    const filas = await this.armado.proveedoresPendientes(anioMes);
    return {
      mes: anioMes,
      total_importe: Math.round(filas.reduce((a, f) => a + f.importe, 0) * 100) / 100,
      filas,
    };
  }

  /**
   * Confirma que un nombre del banco es tal cuenta de ContPAQi.
   *
   * ⛔ Exige `_GESTIONAR` **y** deja el nombre de quien lo afirmó: esto no lo deriva un script, lo
   * dice una persona, y dentro de un año alguien va a querer saber quién.
   *
   * ⚠️ Vive en el puente y no en Compras a propósito: la decisión no es *qué proveedor es* sino
   * *a qué cuenta contable carga*, y eso es del lado de contabilidad. Si Compras termina
   * necesitándolo, es un permiso nuevo repartido con nombre, no abrir éste.
   */
  @Post('alias-proveedor')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR)
  @ApiOperation({ summary: 'Confirma que un concepto del banco carga a una cuenta de proveedor.' })
  async confirmarAlias(
    @Body() body: { concepto_banco: string; cuenta: string; rubro?: string; nota?: string },
    @Req() req: { user?: { username?: string; sub?: string } },
  ) {
    const quien = req?.user?.username || req?.user?.sub;
    if (!quien) throw new BadRequestException('no se pudo identificar quién confirma');
    if (!body?.concepto_banco || !body?.cuenta) {
      throw new BadRequestException('hacen falta `concepto_banco` y `cuenta`');
    }
    try {
      return await this.armado.confirmarAlias({ ...body, confirmado_por: quien });
    } catch (e) {
      // El servicio lanza con el motivo exacto (cuenta inexistente, rubro equivocado): se
      // devuelve tal cual, porque es lo que quien confirma necesita leer para corregir.
      throw new BadRequestException((e as Error).message);
    }
  }

  /**
   * `[CP.8.52]` — **«Ya lo cargué en ContPAQi».** Registra las pólizas del archivo en
   * `contpaqi.poliza_exports` como `entregada` y arranca el reloj del cuadre.
   *
   * ⛔ `archivo_base64` es el archivo que se cargó; si no es idéntico al que la Suite genera hoy
   * para ese mes, **409** con el motivo (el mes cambió desde la descarga, o se subió otro). Marcar
   * dos veces no duplica ni reinicia el plazo. Exige `_GESTIONAR` y deja el nombre de quien afirma.
   */
  @Post('entregas')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_GESTIONAR)
  @ApiOperation({ summary: 'Marca entregado el archivo del mes que ya se cargó en ContPAQi.' })
  async marcarEntregado(
    @Body() body: { mes?: string; archivo_base64?: string },
    @Req() req: { user?: { username?: string; sub?: string } },
  ): Promise<{
    mes: string; polizas: number; nuevas: number; ya_registradas: number; total: number;
    archivo_sha256: string;
  }> {
    const quien = req?.user?.username || req?.user?.sub;
    if (!quien) throw new BadRequestException('no se pudo identificar quién marca la entrega');
    const mes = String(body?.mes ?? '');
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new BadRequestException('hace falta `mes` como AAAA-MM');
    if (!body?.archivo_base64) throw new BadRequestException('hace falta `archivo_base64`: el archivo que se cargó');
    try {
      return await this.armado.marcarEntregado(mes, body.archivo_base64, quien);
    } catch (e) {
      if (e instanceof EntregaRechazada) throw new ConflictException(e.message);
      throw new BadRequestException((e as Error).message);
    }
  }

  /**
   * El estado del cuadre: cuántos eventos entregados aparecieron del otro lado.
   *
   * ⚠️ Hoy devuelve el vacío, y **el vacío es el dato**: nada se ha entregado nunca. Un tablero
   * que mostrara `0 %` sin decir que el denominador es cero mentiría por omisión (ADR-056).
   */
  @Get('cuadre')
  @RequirePermissions(Permission.FISCAL_CONTPAQI_BRIDGE_VER)
  @ApiOperation({ summary: 'Estado del cuadre: entregado vs lo que ContPAQi ya tiene.' })
  async estadoCuadre() {
    return this.cuadre.estado();
  }
}

/**
 * ⭐ El dueño de cada motivo. Es lo que convierte la bandeja en algo accionable: un rechazo sin
 * dueño es un pendiente eterno, y la mitad de estos **no le tocan a nadie**.
 */
const DUENO: Record<string, string> = {
  sin_regla: 'el contador — firma la cuenta de la categoría',
  proveedor_sin_cuenta: 'compras — los alias de proveedor que faltan',
  sin_centro_costo: 'negocio — CB no trae centro de costo por movimiento',
  no_aplica: 'nadie: ya se midió y NO genera póliza',
  sin_medir: 'sistemas — re-correr el derivador con otra ventana',
  contpaqi_cuenta: 'sistemas — el crosswalk de CP.2 (CAJA CG y FACTORAJE no son bancos)',
  importe_invalido: 'sistemas — el movimiento no trae un importe positivo',
  descuadre: 'sistemas — subtotal + IVA no da el total',
  regla_sin_cuenta: 'el contador — la regla está firmada pero sin cuenta',
};

/** El mes cerrado más reciente. ⚠️ No el actual: el mes en curso siempre se ve incompleto. */
function mesPorDefecto(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
