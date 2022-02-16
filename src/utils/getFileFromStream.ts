import { pipeline, PassThrough } from 'stream';
import busboy from 'busboy';
import { Request } from 'express';

export function getFileFromStream(request: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: any = [];
    const clonedStream = pipeline(request, new PassThrough(), reject);
    const busboyStream = busboy({ headers: request.headers });
    busboyStream.on('file', (_, file) => {
      file.on('data', (chunk: any) => {
        if (chunk) {
          chunks.push(chunk);
        }
      });
      file.once('end', () => {
        resolve(Buffer.concat(chunks))
      });
    });
    busboyStream.on('finish', () => {
      clonedStream.end();
    });
    clonedStream.pipe(busboyStream);
  });
}
