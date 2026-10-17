import type { Context } from 'hono';
import {
  BadRequestException,
  Controller,
  Ctx,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Roles,
  UnauthorizedException,
  UseMiddleware,
  getCurrentUser,
} from 'veloce-ts';
import { UPLOAD_MAX_BYTES, type UploadedFile } from '@marketplace/contracts';
import { sniff, UploadRejectedError, type StorageProvider } from '../services/storage';
import { publicReadRateLimit, uploadRateLimit } from '../middleware/rate-limit.middleware';

const QUIEN_SUBE = ['seller', 'admin'];

/**
 * Subida y entrega de imágenes de producto.
 *
 * Sube quien vende; mira cualquiera, porque una foto de catálogo es pública y
 * pedir un token para verla rompería el `<img>` de la portada.
 *
 * Lo que decide si un archivo entra son sus primeros bytes, no su nombre ni el
 * `Content-Type` que manda el navegador: los dos los escribe el cliente.
 */
@Controller('/api/uploads')
export class UploadController {
  constructor(@Inject('StorageProvider') private storage: StorageProvider) {}

  @Post('/')
  @Roles(QUIEN_SUBE)
  @UseMiddleware(uploadRateLimit)
  async upload(@Ctx() c: Context): Promise<UploadedFile> {
    if (!getCurrentUser(c)?.sub) throw new UnauthorizedException('Missing auth context');

    const tipo = c.req.header('content-type') ?? '';
    if (!tipo.toLowerCase().includes('multipart/form-data')) {
      throw new BadRequestException('Manda el archivo como multipart/form-data');
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new BadRequestException('No se pudo leer el formulario');
    }

    const archivo = form.get('file');
    if (!(archivo instanceof File)) throw new BadRequestException('Falta el campo "file"');
    if (archivo.size === 0) throw new BadRequestException('El archivo viene vacío');
    if (archivo.size > UPLOAD_MAX_BYTES) {
      throw new BadRequestException(
        `El archivo pesa ${Math.ceil(archivo.size / 1024)} kB y el límite son ${UPLOAD_MAX_BYTES / 1024} kB`,
      );
    }

    const data = new Uint8Array(await archivo.arrayBuffer());
    const firma = sniff(data);
    if (!firma) {
      throw new BadRequestException('Solo se aceptan imágenes JPEG, PNG o WebP');
    }

    try {
      const guardado = await this.storage.put({ data, ...firma });
      return guardado;
    } catch (error) {
      if (error instanceof UploadRejectedError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get('/:key')
  @UseMiddleware(publicReadRateLimit)
  async serve(@Param('key') key: string) {
    const respuesta = await this.storage.serve(key);
    if (!respuesta) throw new NotFoundException('Ese archivo no existe');
    return respuesta;
  }
}
