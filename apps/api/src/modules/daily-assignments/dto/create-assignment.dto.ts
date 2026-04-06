import { ApiProperty } from '@nestjs/swagger';

export class CreateAssignmentDto {
  @ApiProperty({ description: 'ID del colaborador' })
  user_id!: string;

  @ApiProperty({ description: 'ID de la ruta (catálogo)' })
  route_id!: string;

  @ApiProperty({ description: 'Día de la semana (1-7, donde 1=Lunes)' })
  day_of_week!: number;

  @ApiProperty({ description: 'ID del supervisor que asigna', required: false })
  assigned_by?: string;

  @ApiProperty({ description: 'Estado de la asignación', required: false, default: 'pendiente' })
  status?: string;
}
