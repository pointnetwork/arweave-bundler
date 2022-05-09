// import {readFileSync, existsSync} from 'fs';
import https from 'https';
import http from 'http';
import aws from 'aws-sdk';
import config from 'config';
import {hashFn} from './utils';
import {Request, Response} from 'express';
import {log} from './utils/logger';
import {PassThrough, pipeline} from 'stream';
import {safeStringify} from './utils/safeStringify';
import {request as gqlRequest} from 'graphql-request';
import getDownloadQuery from './utils/getDownloadQuery';
import {delay} from './utils/delay';
import formidable from 'formidable';
import {S3Storage} from './storage/s3Storage';
import {arweaveTxManager} from './arweaveTxManager';
import {arweave} from './arweaveTxManager/arweave';

const S3_URL = `${config.get('s3.protocol')}://${config.get('s3.host')}:${config.get('s3.port')}/` +
`${config.get('s3.bucket')}`;
const RETRY_TIME = 1;
const GATEWAY_URL: string = config.get('storage.arweave_gateway_url');

// if (!config.s3.key || !existsSync(config.s3.key)) {
//   throw new Error('S3 key is not specified');
// }

// if (!config.s3.secret || !existsSync(config.s3.secret)) {
//   throw new Error('S3 secret is not specified');
// }

// const accessKeyId = readFileSync(config.s3.key).toString().trim();
// const secretAccessKey = readFileSync(config.s3.secret).toString().trim();

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

            if (!objInfo.ETag || !S3Storage.integrityCheck(objInfo.ETag + 1, file.etag)) {
                const errorMsg = objInfo.Etag ? `ChunkId found on S3 is corrupted. Etag on s3: ${objInfo.ETag} vs calculcated etag: ${file.etag}` :
                    `ChunkdId ${file.chunkId} not found on S3`;
                log.info(errorMsg);
                try {
                    const uploadFileResult = await this.storage.uploadFile(
                        file.content,
                        {key: file.chunkId});
                    log.info(`ChunkId: ${file.chunkId} is up on S3 with etag: ${file.etag}, location: ${uploadFileResult.Location}`);
                } catch (error) {
                    log.error(safeStringify(error));
                }
            } else {
                log.info(`ChunkId ${file.chunkId} found on S3 and integrity is ok. Skipping S3 uploading`);
            }
            try {
                const tx = await arweaveTxManager.uploadChunk(
                    {chunkId: file.chunkId, fileContent: file.content, tags: fields}
                );
                log.info(`ChunkId ${file.chunkId} was signed and broadcasted with arweave tx: ${tx.txid} status: ${safeStringify(tx.status)}`);
                // TODO: add retry if status is 429 o 404
                response.json({status: 'ok', code: 200, txid: tx.txid, tx_status: tx.status});
            } catch (error) {
                log.error(`ChunkId ${file.chunkId} failed to upload to arweave due to error: ${error}`);
                // TODO: check what went wrong in arweave
            }

        });
    }

    async getArweaveTxs(chunkId: string, retry = 10): Promise<string[]> {
        try {
            const queryResult: any = await gqlRequest(GATEWAY_URL, getDownloadQuery(chunkId, 'desc'));
            if (queryResult.transactions.edges.length > 0) {
                return queryResult.transactions.edges;
            }
            return [];
        } catch (error) {
            if (retry > 0) {
                await delay(RETRY_TIME);
                return this.getArweaveTxs(chunkId, retry - 1);
            }
            return [];
        }
    }

    checkFilesSignatures(fileFromS3, originalFile, chunkId) {
        const originalFileSignature = hashFn(originalFile).toString('hex');
        const dataToSignSignature = hashFn(fileFromS3 as Buffer).toString('hex');
        if (originalFileSignature !== dataToSignSignature) {
            log.error(`Data retrieved from S3 seems to be corrupted. File from s3 contains: ${(fileFromS3 as Buffer).toString()}`);
        }
        if (originalFileSignature !== chunkId) {
            log.error(`Calculated chunkId from file: ${originalFileSignature} is different from provided chunkId: ${chunkId}`);
        }
    }

    async uploadToArweave(file, tags) {
        const transaction = await this.signTx(file, tags);
        const {id: txid} = await this.broadcastTx(transaction);
        const status = await arweave.transactions.getStatus(txid);
        return {status, txid};
    }

    async getFileFromS3(chunkId) {
        return new Promise((resolve, reject) => {
            try {
                const options = {headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}};
                (config.get('s3.protocol') === 'https' ? https : http).get(`${S3_URL}/${chunkId}`, options, function(res) {
                    try {
                        const body: Uint8Array[] = [];
                        res.on('data', (chunk) => body.push(chunk));
                        res.on('end', () => resolve(Buffer.concat(body)));
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) { reject(e); }
        });
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
