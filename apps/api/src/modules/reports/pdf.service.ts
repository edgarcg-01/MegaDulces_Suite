import { Injectable } from '@nestjs/common';
import * as puppeteer from 'puppeteer';
import * as hbs from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PdfService {
  async generarReporte(datos: any): Promise<Buffer> {
    try {
      // 1. Cargar tu plantilla HTML
      const templatePath = path.join(process.cwd(), 'apps', 'api', 'templates', 'reporte.hbs');
      
      let templateHtml: string;
      try {
        templateHtml = fs.readFileSync(templatePath, 'utf8');
      } catch (error) {
        console.error('[PdfService] Error reading template:', error);
        throw new Error('Template file not found');
      }

      // 2. Compilar la plantilla con los datos que manda Angular
      const template = hbs.compile(templateHtml);
      const htmlFinal = template(datos);

      // 3. Iniciar Puppeteer
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();

      // 4. Cargar el HTML en el navegador virtual
      await page.setContent(htmlFinal, { waitUntil: 'load', timeout: 30000 });

      // 5. Generar el PDF
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
      });

      await browser.close();
      
      return Buffer.from(pdfBuffer);
    } catch (error) {
      console.error('[PdfService] Error generating PDF:', error);
      throw error;
    }
  }
}
