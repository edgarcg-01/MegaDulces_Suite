import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class CreateAssignmentDto {
  @ApiProperty({ description: 'ID del colaborador' })
  @IsUUID()
  user_id!: string;

  @ApiProperty({ description: 'ID de la ruta (catálogo)' })
  @IsUUID()
  route_id!: string;

  @ApiProperty({ description: 'Día de la semana (1=Lunes ... 7=Domingo)' })
  @IsInt()
  @Min(1)
  @Max(7)
  day_of_week!: number;

  @ApiProperty({
    description: 'Estado de la asignación',
    required: false,
    default: 'pendiente',
    enum: ['pendiente', 'completado', 'cancelado'],
  })
  @IsOptional()
  @IsIn(['pendiente', 'completado', 'cancelado'])
  status?: string;
}
