import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class UpdateAssignmentDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  route_id?: string;

  @ApiProperty({ required: false, description: '1=Lunes ... 7=Domingo' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  day_of_week?: number;

  @ApiProperty({
    required: false,
    enum: ['pendiente', 'completado', 'cancelado'],
  })
  @IsOptional()
  @IsIn(['pendiente', 'completado', 'cancelado'])
  status?: string;
}
