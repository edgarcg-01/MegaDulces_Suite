import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Valida (y tipa) un @Body()/@Query() contra un schema Zod del contrato
 * compartido (libs/contracts, ADR-052). El tipo Y la validacion salen del MISMO
 * schema → un solo lugar de verdad, cierra el hueco de los @Body() sin validar.
 *
 * Uso:
 *   import { CreateFoo } from '@megadulces/contracts';
 *   @Post()
 *   crear(@Body(new ZodValidationPipe(CreateFoo)) body: CreateFoo) { ... }
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Payload invalido',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return parsed.data;
  }
}
