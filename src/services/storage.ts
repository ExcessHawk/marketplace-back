import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Response as HttpResponse, type FileResponse, type RedirectResponse } from 'veloce-ts';
import { UPLOAD_MAX_BYTES } from '@marketplace/contracts';

/**
 * Almacenamiento de archivos subidos.
 *
 * Misma forma que `PaymentProvider`: una interfaz y una implementación que no
 * depende de ninguna cuenta. Hoy el disco del contenedor; mañana S3 es escribir
 * un segundo adaptador sin tocar el controlador.
 */

export interface StoredFile {
  key: string;
  url: string;
  bytes: number;
  contentType: string;
}

export interface StorageProvider {
  readonly name: string;
  put(input: { data: Uint8Array; contentType: string; ext: string }): Promise<StoredFile>;
  /**
   * Qué contestarle al navegador por esta clave. El disco devuelve el archivo;
   * un S3 devolvería una redirección a una URL firmada, y el controlador no se
   * entera de la diferencia.
   */
  serve(key: string): Promise<FileResponse | RedirectResponse | null>;
  delete(key: string): Promise<void>;
  /** Vacía el almacén. Solo lo usa el reinicio de la demostración. */
  clear(): Promise<number>;
}

export class UploadRejectedError extends Error {}

/**
 * Tipos permitidos, reconocidos por sus primeros bytes y no por el nombre ni
 * por el `Content-Type` que mande el navegador, que son datos del cliente.
 *
 * SVG no está en la lista a propósito: un SVG es un documento que puede traer
 * `<script>`, y estos archivos se sirven desde el mismo origen que la
 * aplicación. El resto son formatos de imagen que el navegador no ejecuta.
 */
const FIRMAS: Array<{ contentType: string; ext: string; test: (b: Uint8Array) => boolean }> = [
  {
    contentType: 'image/jpeg',
    ext: 'jpg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: 'image/png',
    ext: 'png',
    test: (b) =>
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    contentType: 'image/webp',
    ext: 'webp',
    test: (b) =>
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/** Qué es en realidad el archivo. Null si no es ninguno de los permitidos. */
export function sniff(data: Uint8Array): { contentType: string; ext: string } | null {
  if (data.length < 12) return null;
  const firma = FIRMAS.find((f) => f.test(data));
  return firma ? { contentType: firma.contentType, ext: firma.ext } : null;
}

/** Las claves que este servicio genera, y nada más: corta el paso a `../`. */
const CLAVE_VALIDA = /^[0-9a-f]{32}\.(jpg|png|webp)$/;

export function claveValida(key: string): boolean {
  return CLAVE_VALIDA.test(key);
}

export class LocalDiskStorage implements StorageProvider {
  readonly name = 'local-disk';
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private ruta(key: string): string {
    if (!claveValida(key)) throw new UploadRejectedError('Clave de archivo inválida');
    return join(this.dir, key);
  }

  async put(input: { data: Uint8Array; contentType: string; ext: string }): Promise<StoredFile> {
    if (input.data.byteLength > UPLOAD_MAX_BYTES) {
      throw new UploadRejectedError('El archivo pesa más de lo permitido');
    }
    await mkdir(this.dir, { recursive: true });
    const key = `${randomUUID().replace(/-/g, '')}.${input.ext}`;
    await writeFile(this.ruta(key), input.data);
    return {
      key,
      url: `/api/uploads/${key}`,
      bytes: input.data.byteLength,
      contentType: input.contentType,
    };
  }

  async serve(key: string): Promise<FileResponse | null> {
    if (!claveValida(key)) return null;
    // Que el archivo falte es un 404 del controlador, no una excepción dentro
    // del serializador de respuestas.
    try {
      if (!(await stat(this.ruta(key))).isFile()) return null;
    } catch {
      return null;
    }
    const ext = key.slice(key.lastIndexOf('.') + 1);
    const firma = FIRMAS.find((f) => f.ext === ext);
    // `fileFrom` ancla la ruta al directorio: lo que se salga de ahí se niega
    // dentro del framework, no aquí.
    return HttpResponse.fileFrom(this.dir, key, {
      contentType: firma?.contentType ?? 'application/octet-stream',
    });
  }

  async delete(key: string): Promise<void> {
    if (!claveValida(key)) return;
    await rm(this.ruta(key), { force: true });
  }

  async clear(): Promise<number> {
    let archivos: string[];
    try {
      archivos = await readdir(this.dir);
    } catch {
      return 0;
    }
    const borrables = archivos.filter(claveValida);
    await Promise.all(borrables.map((key) => rm(join(this.dir, key), { force: true })));
    return borrables.length;
  }
}

export function createStorageProvider(): StorageProvider {
  return new LocalDiskStorage(process.env.UPLOADS_DIR ?? './data/uploads');
}
