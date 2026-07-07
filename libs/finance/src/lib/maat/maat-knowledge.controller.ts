import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { MaatKnowledgeService, KnowledgeEntry } from './maat-knowledge.service';

@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat')
export class MaatKnowledgeController {
  constructor(private readonly knowledge: MaatKnowledgeService) {}

  @Get('knowledge')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.0 — Base de conocimiento de Maat. Filtros: kind, q (ILIKE), status, limit.' })
  list(
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.knowledge.list({ kind, q, status, limit: limit ? Number(limit) : undefined });
  }

  @Get('knowledge/stats')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MAAT.0 — Conteos por kind/status (salud de la base de conocimiento).' })
  stats() {
    return this.knowledge.stats();
  }

  @Post('knowledge')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.0 — Alta/actualización idempotente de conocimiento (upsert por kind+title).' })
  upsert(@Body() body: KnowledgeEntry, @Req() req: { user?: { username?: string } }) {
    return this.knowledge.upsert({ ...body, source: body.source || 'finanzas', created_by: req?.user?.username || null });
  }

  @Post('knowledge/reindex')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.9 (RAG) — Re-embebe todo el conocimiento activo en el índice vectorial (Voyage + pgvector).' })
  reindex() {
    return this.knowledge.reindexVectors();
  }

  @Patch('knowledge/:id/status')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @ApiOperation({ summary: 'MAAT.0 — Retirar/reactivar una entrada (status=active|retired).' })
  setStatus(@Param('id') id: string, @Body('status') status: 'active' | 'retired') {
    return this.knowledge.setStatus(id, status);
  }
}
