import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PortalAiOrderService } from './portal-ai-order.service';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@ApiTags('portal-ai-order')
@Controller('commercial/ai-order')
export class PortalAiOrderController {
  constructor(private readonly service: PortalAiOrderService) {}

  @Post('suggest')
  @ApiOperation({ summary: 'Sugerir productos para el pedido vía Claude Haiku' })
  async suggest(
    @Req() req: any,
    @Body() body: { message: string; history?: ChatMessage[] },
  ) {
    const user = req.user;
    if (!user) throw new UnauthorizedException('JWT inválido');
    return this.service.suggest({
      message: body.message,
      history: Array.isArray(body.history) ? body.history : [],
      customerId: user.customer_id || null,
      tenantId: user.tenant_id,
    });
  }
}
