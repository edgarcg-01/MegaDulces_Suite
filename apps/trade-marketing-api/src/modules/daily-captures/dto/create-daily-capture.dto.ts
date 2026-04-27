import { ApiProperty } from '@nestjs/swagger';

export class CreateDailyCaptureDto {
  @ApiProperty({ description: 'Identificador único de la captura, ej. J-31-153045' })
  folio!: string;

  @ApiProperty({ description: 'Fecha de la captura diaria en formato YYYY-MM-DD', example: '2026-03-31' })
  fechaCaptura!: string;

  @ApiProperty({ description: 'Hora de inicio de la auditoría en formato ISO' })
  horaInicio!: string;

  @ApiProperty({ description: 'Hora de fin de la auditoría en formato ISO' })
  horaFin!: string;

  @ApiProperty({ description: 'Array de exhibidores reportados con base64 opcional' })
  exhibiciones!: Record<string, any>[];

  @ApiProperty({ description: 'Estructura en formato JSONB con el resumen estadístico de esta captura' })
  stats!: Record<string, any>;

  @ApiProperty({ description: 'Latitud de la captura diaria', required: false })
  latitud?: number;

  @ApiProperty({ description: 'Longitud de la captura diaria', required: false })
  longitud?: number;
}
