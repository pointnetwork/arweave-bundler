import {Endpoint, S3} from 'aws-sdk';
import {Storage} from './storage';
import retry from 'async-retry';
import {splitBuffer} from '../utils/splitBuffer';
import {md5} from '../utils/md5';
import {log} from '../utils/logger';
import {safeStringify} from '../utils/safeStringify';

const DEFAULT_PART_SIZE_BYTES = 1024 * 1024 * 8; // 8MB. Don't change this value since it will affect how etags are calculated

export const DEFAULT_RETRY_POLICY = {
    retries: 3,
    minTimeout: 2000
};

interface S3StorageOpts {
  protocol?: string;
  host: string;
  port: number;
  accessKeyId: string;
  secretAccessKey: string;
  computeChecksums?: boolean;
  s3ForcePathStyle?: boolean;
  defaultBucket: string;
  ACL?: string;
  ContentType?: string;
  partSize?: number;
}

const defaultS3StorageOpts: Partial<S3StorageOpts> = {
    protocol: 'http',
    computeChecksums: false,
    s3ForcePathStyle: true,
    ACL: 'public-read',
    ContentType: 'application/octet-stream',
    partSize: DEFAULT_PART_SIZE_BYTES
};

export class S3Storage extends Storage<S3StorageOpts> {

    private s3 :S3;
    private opts: S3StorageOpts;
    constructor(opts: S3StorageOpts) {
        super(opts);
        this.opts = {
            ...defaultS3StorageOpts,
            ...opts
        };
        const {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            defaultBucket, ACL, ContentType, partSize, protocol, host,
            port, ...rest
        } = this.opts;
        this.s3 = new S3({
            endpoint: new Endpoint(`${protocol}://${host}:${port}`),
            ...rest
        });
    }

    static cleanTag(tag) {
        if (tag.length === 34 && tag[tag.length - 2] !== '-') {
            return tag.slice(1, -1);
        }
        return tag;
    }

    static integrityCheck(a, b) {
        return S3Storage.cleanTag(a) === S3Storage.cleanTag(b);
    }

    static calculateEtag(content: Uint8Array, partSize = defaultS3StorageOpts.partSize) {
        const parts = Math.ceil(content.length / (partSize as number));
        if (parts === 1) {
            return md5(content);
        }
        const totalMd5 = md5(Buffer.from(splitBuffer(content, partSize as number).map(md5).join(''), 'hex'));
        return `${totalMd5}-${parts}`;
    }

    public getObjectMetadata(key: string, bucket?: string) {
        return retry(
            async () => {
                try {
                    const result = await this.s3.headObject({
                        Bucket:  bucket || this.opts.defaultBucket,
                        Key: key
                    }).promise();
                    return result;
                } catch (error) {
                    if (error.statusCode === 404) {
                        return {};
                    }
                    log.error(safeStringify(error));
                }
            },
            DEFAULT_RETRY_POLICY
        );
    }

    async uploadFile(
        file: Buffer,
        config: { bucket?: string, key: string, ACL?: string, ContentType?: string, etag?: string }
    ) {
        return retry(
            async () => {
                const result = await this.s3.upload({
                    Bucket: config.bucket || this.opts.defaultBucket,
                    Key: config.key,
                    Body: file,
                    ACL: config.ACL || this.opts.ACL,
                    ContentType: config.ContentType || this.opts.ContentType
                }, {partSize: this.opts.partSize}).promise();
                if (config.etag) {
                    if (S3Storage.integrityCheck(result.ETag, config.etag)) {
                        return result;
                    } else {
                        const errorMsg = `Integrity check error uploading chunkId: ${config.key}. Receivd Etag: ${result.ETag} Calculcated Etag: ${config.etag}`;
                        log.error(errorMsg);
                        throw new Error(errorMsg);
                    }
                }
                return result;
            },
            DEFAULT_RETRY_POLICY
        );
    }

}
