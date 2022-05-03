// import {readFileSync, existsSync} from 'fs';
import Arweave from 'arweave';
import https from 'https';
import http from 'http';
import aws from 'aws-sdk';
import multer from 'multer';
import multerS3 from 'multer-s3';
import config from 'config';
import TestWeave from 'testweave-sdk';
import {getFileFromStream, hashFn} from './utils';
import {Request, Response} from 'express';
import {log} from './utils/logger';

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
    s3ForcePathStyle: true // needed with minio?
});

const params = {Bucket: config.get('s3.bucket') as string, Key: 'testobject', Body: 'Hello from MinIO!!'};
s3.putObject(params, function(err, data) {
    if (err)
        log.error(err);
    else
        log.info(data, 'Successfully uploaded data to testbucket/testobject');
});

const upload = multer({
    storage: multerS3({
        s3,
        bucket: config.get('s3.bucket'),
        acl: 'public-read',
        key: function (request, _, cb) {
            cb(null, request.headers.chunkid);
        }
    })
}).array('file', 1);

const key = JSON.parse(config.get('arweave.key'));

class Signer {
    signPOST(request: Request & { filePromise: Promise<Buffer>}, response: Response) {
        if (!request.headers.chunkid) {
          const errMsg = 'Request to /signPOST is missing the mandatory `chunkid` header.'
          log.error(errMsg);
          response.status(400).json({status: 'error', code: 400, errMsg});
          return;
        }
        log.info({chunkId: request.headers.chunkid}, 'Received request to upload chunk.')
        request.filePromise = getFileFromStream(request);
        return upload(request, response, this.getTxId.bind(this, request, response));
    }

    async getTxId(
        request: Request & { filePromise: Promise<Buffer> },
        response: Response,
        error?: Error
    ) {
        if (error) {
            response.json({status: 'error', code: 500, error});
            return;
        }

        try {
            // const subdomain = ''; // bucketName ? `${bucketName}.` : '';
            const originalFile = await request.filePromise;
            const url = `${config.get('s3.protocol')}://${config.get('s3.host')}:${config.get('s3.port')}/` +
        `${config.get('s3.bucket')}/${request.headers.chunkid}`;

            const dataToSign = await new Promise((resolve, reject) => {
                try {
                    const options = {headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}};
                    (config.get('s3.protocol') === 'https' ? https : http).get(url, options, function(res) {
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
            const tagsToSign = this.getTagsFromRequest(request);
            const originalFileSignature = hashFn(originalFile).toString('hex');
            const dataToSignSignature = hashFn(dataToSign as Buffer).toString('hex');
            const originalSignature = tagsToSign.__pn_chunk_id;
            if (originalFileSignature !== dataToSignSignature) {
                log.error('Data retrieved from S3 seems to be corrupted');
            }
            if (originalFileSignature !== originalSignature) {
                log.error('Data hash is different from chunkId, check hashFn or integrity of the data');
            }
            const transaction = await this.signTx(originalFile, tagsToSign);
            const {id: txid} = await this.broadcastTx(transaction);
            const status = await arweaveClient.transactions.getStatus(txid);
            log.info({
                id: txid,
                status,
                hash: originalSignature
            }, 'Successfully processed transaction: ');
            log.sendMetric({
                arweaveTransaction: txid,
                tx_status: status,
                hash: originalSignature,
                arweaveTransactionFailure: false
            });
            response.json({status: 'ok', code: 200, txid, tx_status: status});
        } catch (error) {
            log.error({error}, 'Upload error');
            log.sendMetric({arweaveTransactionFailure: true});
            response.json({status: 'error', code: 500, error});
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

    async getFileFromS3(req: Request, res: Response) {
        const {chunkId} = req.params;
        if (!chunkId) {
            const errMsg = 'Request is missing the required `chunkId` param.';
            log.error(errMsg);
            res.status(400).json({status: 'error', code: 400, errMsg});
            return;
        }

        log.info({chunkId}, 'Request to fetch file from S3.');

        const params = {
          Bucket: config.get('s3.bucket'),
          Key: chunkId,
        };

        s3.getObject(params, (err, data) => {
          if (err) {
            log.error(err, `Error fetching file "${chunkId}" from S3`);
            const statusCode = err.statusCode || 500;
            res.status(statusCode).json({status: 'error', code: statusCode, err});
            return;
          }

          res.json(data);
        });
    }
}

const arweaveClient = Arweave.init({
    ...config.get('arweave'),
    timeout: 20000,
    logging: true
});

let arweave;

if (parseInt(config.get('testmode'))) {
    let testWeave;
    arweave = new Proxy({}, {
        get: (_, prop) => prop !== 'transactions' ? arweaveClient[prop] : new Proxy({}, {
            get: (_, txProp) => txProp !== 'getUploader' ? arweaveClient[prop][txProp] : async (upload, data) => {
                const uploader = await arweaveClient[prop][txProp](upload, data);
                return new Proxy({}, {
                    get: (_, uploaderProp) => uploaderProp !== 'uploadChunk' ? uploader[uploaderProp] : async (...args) => {
                        try {
                            log.info('Uploading chunk in test mode');
                            if (!testWeave) {
                                log.info('Initializing Testweave');
                                testWeave = await TestWeave.init(arweave);
                                testWeave._rootJWK = key;
                            }
                            const result = await uploader[uploaderProp](...args);
                            await testWeave.mine();
                            return result;
                        } catch (error) {
                            log.error({error}, 'Fatal error');
                            throw error;
                        }
                    }
                });
            }
        })
    });
} else {
    arweave = arweaveClient;
}

arweave.network.getInfo().then((info) => log.info(info, 'Arweave network info'));

export default new Signer();
