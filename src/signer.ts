// import {readFileSync, existsSync} from 'fs';
import Arweave from 'arweave';
import https from 'https';
import http from 'http';
import aws from 'aws-sdk';
import multer from 'multer';
import multerS3 from 'multer-s3';
import config from 'config';
import TestWeave from 'testweave-sdk';
import { getFileFromStream, hashFn } from './utils';
import { Request, Response } from 'express';

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
  s3ForcePathStyle: true, // needed with minio?
});


var params = {Bucket: config.get('s3.bucket') as string, Key: 'testobject', Body: 'Hello from MinIO!!'};
s3.putObject(params, function(err, data) {
  if (err)
    console.log(err)
  else
    console.log("Successfully uploaded data to testbucket/testobject", data);
});

const upload = multer({
  storage: multerS3({
    s3,
    bucket: config.get('s3.bucket'),
    acl: 'public-read',
    key: function (request, _, cb) {
      const name = readableRandomStringMaker(20);
      request.__name = name;
      cb(null, name);
    }
  })
}).array('file', 1);

const key = JSON.parse(config.get('arweave.key'));

class Signer {
  signPOST(request: Request & { filePromise: Promise<Buffer>}, response: Response) {
    request.filePromise = getFileFromStream(request);
    return upload(request, response, this.getTxId.bind(this, request, response));
  }

  async getTxId(
    request: Request & { filePromise: Promise<Buffer>, __name?: string },
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
        `${config.get('s3.bucket')}/${request.__name}`;

      const dataToSign = await new Promise((resolve, reject) => {
        try {
          const options = {headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          }};
          (config.get('s3.protocol') === 'https' ? https : http).get(url, options, function(res) {
            try {
              const body: Uint8Array[] = [];
              res.on('data', (chunk) => body.push(chunk));
              res.on('end', () => resolve(Buffer.concat(body)));
            } catch(e) {
              reject(e);
            }
          });
        } catch(e) { reject(e); }
      });
      const tagsToSign = this.getTagsFromRequest(request);
      const originalFileSignature = hashFn(originalFile).toString('hex');
      const dataToSignSignature = hashFn(dataToSign as Buffer).toString('hex');
      const originalSignature = tagsToSign.__pn_chunk_id;
      if (originalFileSignature !== dataToSignSignature) {
        console.error('Data retrieved from S3 seems to be corrupted');
      }
      if (originalFileSignature !== originalSignature) {
        console.error('Data hash is different from chunkId, check hashFn or integrity of the data');
      }
      const transaction = await this.signTx(originalFile, tagsToSign);
      const { id: txid } = await this.broadcastTx(transaction);
      const status = await arweaveClient.transactions.getStatus(txid);
      console.log('Successfully processed transaction: ', {
          id: txid,
          status,
          hash: originalSignature
      });
      response.json({ status: 'ok', code: 200, txid, tx_status: status });
    } catch (error) {
      console.error('Upload error:', error);
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
    // console.log('getTagsFromRequest, req.body', req.body, 'req.query', req.query)
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
    let transaction = await arweave.createTransaction({ data }, this.getKey());

    // transaction.addTag('keccak256hex', hash);
    // transaction.addTag('pn_experiment', '1');
    for(let k in tags) {
      let v = tags[k];
      transaction.addTag(k, v);
    }

    // Sign
    await arweave.transactions.sign(transaction, this.getKey());

    return transaction;
  }

  async broadcastTx(transaction) {
    let uploader = await arweave.transactions.getUploader(transaction);

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

    res.json({'status':'ok', 'txid': transaction.id /*, 'bundler_response_status': response.status */ });
  }
}

function readableRandomStringMaker(length) {
  const source = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  while (result.length < length) {
    result += source.charAt(Math.random()*62|0);
  }
  return result;
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
                console.log('Uploading chunk in test mode');
              if (!testWeave) {
                  console.log('Initializing Testweave');
                testWeave = await TestWeave.init(arweave);
                testWeave._rootJWK = key;
              }
              const result = await uploader[uploaderProp](...args);
              await testWeave.mine();
              return result;
            } catch (e) {
              console.error('Fatal error:', e);
              throw e;
            }
          }
        });
      }
    })
  });
} else {
  arweave = arweaveClient;
}

arweave.network.getInfo().then((info) => console.info('Arweave network info:', info));

export default new Signer();
