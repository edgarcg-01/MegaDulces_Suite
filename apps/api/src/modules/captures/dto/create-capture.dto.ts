import { ApiProperty } from '@nestjs/swagger';

export class CreateCaptureDto {
  @ApiProperty({ description: 'Datos operacionales en forma de KPIs almacenados en JSONB' })
  kpis_data!: Record<string, any>;
}
