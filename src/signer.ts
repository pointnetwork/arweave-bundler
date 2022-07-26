// import {readFileSync, existsSync} from 'fs';
import aws from 'aws-sdk';
import config from 'config';
import {hashFn} from './utils';
import {Request, Response} from 'express';
import {log} from './utils/logger';
import {PassThrough, pipeline} from 'stream';
import {safeStringify} from './utils/safeStringify';
import formidable from 'formidable';
import {S3Storage} from './storage/s3Storage';
import {queueBroker} from './utils/queueBroker';
import {arweave} from './arweave';

const accessKeyId = config.get('s3.key') as string;
const secretAccessKey = config.get('s3.secret') as string;

const s3 = new aws.S3({
    endpoint: new aws.Endpoint(`${config.get('s3.protocol')}://${config.get('s3.host')}:${config.get('s3.port')}`),
    accessKeyId,
    secretAccessKey,
    computeChecksums: true,
    s3ForcePathStyle: true // needed with minio?
});

const params = {
    Bucket: config.get('s3.bucket') as string,
    Key: 'testobject',
    Body: 'Hello from MinIO!!'
};
s3.putObject(params, function(err) {
    if (err)
        log.error(`S3 error message for testobject: ${err.message}, stack: ${safeStringify(err.stack)}`);
    else
        log.info('Successfully uploaded data to testbucket/testobject');
});

const key = JSON.parse(config.get('arweave.key'));

interface AdditonalRequestParams {
  filePromise: Promise<Buffer>
  arweaveTxs?: string[];
}

function addMetadata(content) {
    return {
        content,
        chunkId: hashFn(content).toString('hex'),
        etag: S3Storage.calculateEtag(content)
    };
}

function getContentFactory(addAdditionalInfo: (content) => any) {
    return (files) => {
        const passthrough = new PassThrough();
        const chunks: Uint8Array[] = [];
        passthrough.on('data', (chunk) => {
            if (chunk) {
                chunks.push(chunk);
            }
        });
        passthrough.once('end', () => {
            const content = Buffer.concat(chunks);
            const fileInfo = addAdditionalInfo(content);
            Object.entries(fileInfo).forEach(([key, value]) => files[key] = value);
        });
        return passthrough;
    };
}

class Signer {

    storage: S3Storage;
    queue = queueBroker;
    constructor() {
        this.storage = new S3Storage({
            protocol: config.get('s3.protocol'),
            host: config.get('s3.host'),
            port: config.get('s3.port'),
            defaultBucket: config.get('s3.bucket'),
            accessKeyId,
            secretAccessKey,
            computeChecksums: true
        });
    }
    async signPOST(request: Request & AdditonalRequestParams, response: Response) {
        const form = formidable(
            {fileWriteStreamHandler: getContentFactory(addMetadata)}
        );
        form.parse(request, async (err, fields, {file}) => {
            if (err) {
                log.error(safeStringify(err));
                response.writeHead(err.httpCode || 400, {'Content-Type': 'text/plain'});
                response.end(String(err));
                return;
            }
            const objInfo = await this.storage.getObjectMetadata(file.chunkId);

            if (!objInfo.ETag || !S3Storage.integrityCheck(objInfo.ETag, file.etag)) {
                const errorMsg = objInfo.Etag ? `ChunkId found on S3 is corrupted. Etag on s3: ${objInfo.ETag} vs calculcated etag: ${file.etag}` :
                    `ChunkdId ${file.chunkId} not found on S3`;
                log.info(errorMsg);
                try {
                    const uploadFileResult = await this.storage.uploadFile(
                        file.content,
                        {key: file.chunkId});
                    log.info(`ChunkId: ${file.chunkId} is up on S3 with etag: ${file.etag}, location: ${uploadFileResult.Location}`);
                    try {
                        const message = {chunkId: file.chunkId, fields};
                        await queueBroker.sendDelayedMessage('verifyChunkId', message, {ttl: 0});
                    } catch (e) {
                        log.error(`Failed to enqueue message in verifyChunkId queue`);
                        return response.sendStatus(500);
                    }
                } catch (error) {
                    log.error(safeStringify(error));
                    return response.sendStatus(500);
                }
            } else {
                log.info(`ChunkId ${file.chunkId} found on S3 and integrity is ok. Skipping S3 uploading`);
                this.queue.sendMessage('verifyChunkId', {chunkId: file.chunkId, fields});
            }
            response.json({status: 'ok', code: 200});
        });
    }

    async isUploaded(request: Request, response: Response) {
        const {chunkId} = request.params;
        if (!chunkId) {
            const errMsg = 'Request is missing the required `chunkId` param.';
            log.error(`Route: is_uploaded/:chunkId, Error: ${errMsg}`);
            return response.status(400).json({status: 'error', code: 400, errMsg});
        }
        const objInfo = await this.storage.getObjectMetadata(chunkId);
        if (objInfo.ETag) {
            response.json({status: 'ok', code: 200});
        } else {
            response.sendStatus(404);
        }
    }

    getKey() {
        return key;
    }

    keyToAddress(key) {
    // Get the wallet address for a private key
        return arweave.wallets.jwkToAddress(key);
    }

    async health(_, res) {
        res.sendStatus(200);
    }

    async address(_, res) {
        const key = this.getKey();
        const address = await this.keyToAddress(key);
        res.json({address});
    }

    async balance(_, res) {
        const key = this.getKey();
        const address = await this.keyToAddress(key);
        const balance = await arweave.wallets.getBalance(address);
        res.json({address, balance});
    }

    getDataFromRequest(req) {
        let dataToSign;
        if (req.query && req.query.data) {
            dataToSign = req.query.data;
        } else if (req.body && req.body.data) {
            dataToSign = req.body.data;
        } else {
            throw Error('no data sent');
        }
        return dataToSign;
    }

    getTagsFromRequest(req) {
        let tagsToSign;
        if (req.query && req.query.tags) {
            tagsToSign = req.query.tags;
        } else if (req.body) {
            tagsToSign = req.body;
        } else {
            tagsToSign = {};
        }
        return tagsToSign;
    }

    async signTx(data, tags) {
    // Real 'AR' mode
        const transaction = await arweave.createTransaction({data}, this.getKey());

        // transaction.addTag('keccak256hex', hash);
        // transaction.addTag('pn_experiment', '1');
        for (const k in tags) {
            const v = tags[k];
            transaction.addTag(k, v);
        }

        // Sign
        await arweave.transactions.sign(transaction, this.getKey());

        return transaction;
    }

    async broadcastTx(transaction) {
        const uploader = await arweave.transactions.getUploader(transaction);

        while (!uploader.isComplete) {
            await uploader.uploadChunk();
        }

        return transaction;
    }

    async sign(req, res) {
        const dataToSign = this.getDataFromRequest(req);
        const tagsToSign = this.getTagsFromRequest(req);
        let transaction = await this.signTx(dataToSign, tagsToSign);
        transaction = await this.broadcastTx(transaction);

        res.json({status:'ok', txid: transaction.id /*, 'bundler_response_status': response.status */});
    }

    async getFileFromS3Route(req: Request, res: Response) {
        const {chunkId} = req.params;
        if (!chunkId) {
            const errMsg = 'Request is missing the required `chunkId` param.';
            log.error(`Route: download/chunkId, Error: ${errMsg}`);
            return res.status(400).json({status: 'error', code: 400, errMsg});
        }

        log.info(`Request to fetch chunkId: ${chunkId} from S3`);

        const params = {
            Bucket: config.get('s3.bucket'),
            Key: chunkId
        };

        s3.headObject(params, (err) => {
            if (err) {
                if (err.code === 'NotFound') {
                    return res.sendStatus(404);
                }
                const statusCode = (err as any)?.statusCode || 500;
                return res.status(statusCode).json({status: 'error', code: statusCode, err});
            }
            const fileStream = s3.getObject(params).createReadStream();
            res.attachment(chunkId);
            pipeline(fileStream, res, (err) => {
                if (err) {
                    log.error(`chunkId: ${chunkId} coudn't be downloaded from S3 in download route. Error ${safeStringify(err)}`);
                }
                log.info(`chunkId: ${chunkId} was succesfully served by download route`);
            });
        });
    }

}

export default new Signer();
