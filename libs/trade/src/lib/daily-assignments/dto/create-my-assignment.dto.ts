import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Auto-asignación de ruta (self-service). El colaborador/vendedor elige su
 * propia ruta del día desde /captures — `user_id` NO va en el body, se fuerza
 * al `sub` del JWT en el controller. Gateado por VISITAS_REGISTRAR.
 */
export class CreateMyAssignmentDto {
  @ApiProperty({ description: 'ID de la ruta (catálogo)' })
  @IsUUID()
  route_id!: string;

  @ApiProperty({ description: 'Día de la semana (1=Lunes ... 7=Domingo)' })
  @IsInt()
  @Min(1)
  @Max(7)
  day_of_week!: number;

  @ApiProperty({
    required: false,
    default: 'pendiente',
    enum: ['pendiente', 'completado', 'cancelado'],
  })
  @IsOptional()
  @IsIn(['pendiente', 'completado', 'cancelado'])
  status?: string;
}
