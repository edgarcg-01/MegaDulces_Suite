import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PortalAiOrderService } from './portal-ai-order.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@ApiTags('portal-ai-order')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/ai-order')
export class PortalAiOrderController {
  constructor(private readonly service: PortalAiOrderService) {}

  @Post('suggest')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Sugerir productos para el pedido vía Claude Haiku' })
  async suggest(
    @Req() req: any,
    @Body() body: { message: string; history?: ChatMessage[] },
  ) {
    return this.service.suggest({
      message: body.message,
      history: Array.isArray(body.history) ? body.history : [],
      tenantId: req.user?.tenant_id,
    });
  }
}
