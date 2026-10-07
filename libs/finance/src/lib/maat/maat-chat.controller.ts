import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { MaatChatService, MaatChatTurn } from './maat-chat.service';
import { MaatScope } from './maat-tools.service';
import { MaatBriefingService } from './maat-briefing.service';

interface AuthedRequest {
  user?: { id?: string; username?: string; full_name?: string };
  /** express: 'close' avisa que el cliente abortó (dispara también al terminar bien). */
  on?: (ev: string, cb: () => void) => void;
}

@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat')
export class MaatChatController {
  constructor(
    private readonly chat: MaatChatService,
    private readonly briefing: MaatBriefingService,
  ) {}

  @Get('briefing')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.3.1 — Briefing financiero determinista para el empty-state del chat (gasto 30d, hallazgos, riesgos, sugerencias).' })
  getBriefing() {
    return this.briefing.build();
  }

  @Post('chat')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @Throttle({ long: { limit: 15, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'MAAT.3 — "Pregúntale a Maat": chat financiero tool-use (egresos, proveedores, documentos, hallazgos, conocimiento). Stateless: enviar `history`. `session_id` opcional agrupa el audit.',
  })
  async maatChat(
    @Req() req: AuthedRequest,
    @Body() body: {
      history?: MaatChatTurn[];
      message?: string;
      think?: boolean;
      deep_search?: boolean;
      session_id?: string;
      image?: { media_type?: string; data?: string };
    },
  ) {
    const history: MaatChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    if (body?.message) history.push({ role: 'user', content: String(body.message) });
    const userName = req.user?.full_name || req.user?.username || undefined;
    const scope: MaatScope = { userName };
    const image = body?.image?.data && body?.image?.media_type
      ? { mediaType: body.image.media_type, data: body.image.data }
      : undefined;
    const result = await this.chat.ask(scope, {
      history,
      think: !!body?.think,
      deepSearch: !!body?.deep_search,
      image,
      // Este camino es el FALLBACK del stream y corre bajo los 60 s de nginx
      // (`location /api/` no define proxy_read_timeout): con deep_search son 12
      // iteraciones × Claude + tools, así que se cierra honesto a los 45 s en vez
      // de que el proxy devuelva 504 sin respuesta.
      deadlineMs: 45_000,
    });
    const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
    const audit = await this.chat.logExchange(
      { sessionId: body?.session_id || null, userId: req.user?.id, userName, question: lastQuestion },
      result,
    );
    return { ...result, ...audit };
  }

  // NO usa `@Sse()` de Nest a propósito: ese decorador registra la ruta como GET,
  // y el payload de aquí (historia + imagen base64) no cabe en query string.
  // Además EventSource no manda Authorization y el front necesita el interceptor
  // de auth: por eso POST + text/event-stream a mano, leído con HttpClient
  // (observe:'events' + partialText). Ver ADR-045.
  @Post('chat/stream')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @Throttle({ long: { limit: 15, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'MAAT.3 — chat con streaming SSE: emite `step` con el progreso REAL de cada tool (descriptivo) y `done` con el resultado + audit. Fallback: usar POST /chat.',
  })
  async maatChatStream(
    @Req() req: AuthedRequest,
    @Res() res: Response,
    @Body() body: {
      history?: MaatChatTurn[];
      message?: string;
      think?: boolean;
      deep_search?: boolean;
      session_id?: string;
      image?: { media_type?: string; data?: string };
    },
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: no bufferear el stream
    (res as any).flushHeaders?.();
    // El cliente se fue (cerró la pestaña, navegó, unsubscribe del HttpClient).
    // 'close' también dispara al terminar bien → distinguir con writableEnded.
    let clientGone = false;
    req.on?.('close', () => { if (!res.writableEnded) clientGone = true; });
    const alive = () => !clientGone && !res.writableEnded;
    const write = (chunk: string) => { if (alive()) res.write(chunk); };
    const send = (event: string, data: any) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const keepAlive = setInterval(() => write(`: ping\n\n`), 15_000);
    try {
      const history: MaatChatTurn[] = Array.isArray(body?.history) ? body.history : [];
      if (body?.message) history.push({ role: 'user', content: String(body.message) });
      const userName = req.user?.full_name || req.user?.username || undefined;
      const scope: MaatScope = { userName };
      const image = body?.image?.data && body?.image?.media_type
        ? { mediaType: body.image.media_type, data: body.image.data }
        : undefined;
      send('step', { label: 'Analizando tu pregunta…' });
      const result = await this.chat.ask(
        scope,
        {
          history, think: !!body?.think, deepSearch: !!body?.deep_search, image,
          shouldStop: () => clientGone,
        },
        (step) => send('step', step),
      );
      // Cliente ido: ni audit (respuesta que nadie va a leer) ni evento final.
      if (clientGone) return;
      const lastQuestion = [...history].reverse().find((t) => t.role === 'user')?.content || '';
      const audit = await this.chat.logExchange(
        { sessionId: body?.session_id || null, userId: req.user?.id, userName, question: lastQuestion },
        result,
      );
      send('done', { ...result, ...audit });
    } catch {
      send('error', { message: 'stream_failed' });
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
  }

  @Post('chat/feedback')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.3 — 👍/👎 sobre una respuesta del chat (colector del aprendizaje L2). vote: 1 | -1.' })
  feedback(@Body() body: { message_id?: string; vote?: number }) {
    if (!body?.message_id) return { ok: false };
    return this.chat.recordFeedback(body.message_id, Number(body.vote) || 0);
  }
}
