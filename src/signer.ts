import Arweave from 'arweave';
import https from 'https';
import http from 'http';
import aws from 'aws-sdk';
import multer from 'multer';
import multerS3 from 'multer-s3';
import config from 'config';
import {readFileSync, existsSync} from 'fs';
import TestWeave from 'testweave-sdk';

const key = require(config.keystore);

if (!config.s3.key || !existsSync(config.s3.key)) {
  throw new Error('S3 key is not specified');
}

if (!config.s3.secret || !existsSync(config.s3.secret)) {
  throw new Error('S3 secret is not specified');
}

const s3 = new aws.S3({
  endpoint: new aws.Endpoint(`${config.s3.protocol}://${config.s3.host}:${config.s3.port}`),
  accessKeyId: readFileSync(config.s3.key).toString(),
  secretAccessKey: readFileSync(config.s3.secret).toString()
});

console.log('S3 host:', `${config.s3.protocol}://${config.s3.host}:${config.s3.port}`);

const upload = multer({
  storage: multerS3({
    s3,
    bucket: config.s3.bucket,
    acl: 'public-read',
    key: function (request, _, cb) {
      const name = readableRandomStringMaker(20);
      request.__name = name;
      cb(null, name);
    }
  })
}).array('file', 1);

class Signer {
  signPOST(request, response) {
    return upload(request, response, this.getTxId.bind(this, request, response));
  }

  async getTxId(request, response, error) {
    if (error) {
      response.json({status: 'error', code: 500, error});
      return;
    }

    try {
      const name = request.__name;
      const bucketName = config.s3.bucket && config.s3.bucket.trim();
      const subdomain = bucketName ? `${bucketName}.` : '';
      const url = `${config.s3.protocol}://${subdomain}${config.s3.host}:${config.s3.port}/${name}`;

      const dataToSign = await new Promise((resolve, reject) => {
        try {
          (config.s3.protocol === 'https' ? https : http).get(url,function (res) {
            try {
              const body: Uint8Array[] = [];
              res.on('data', function (chunk) { body.push(chunk); });
              res.on('end', function () { resolve(Buffer.concat(body)); });
            } catch(e) { reject(e); }
          });
        } catch(e) { reject(e); }
      });


      const tagsToSign = this.getTagsFromRequest(request);
      const transaction = await this.signTx(dataToSign, tagsToSign);
      const {id: txid} = await this.broadcastTx(transaction);

      response.json({status: 'ok', code: 200, txid/*, bundler_response_status: response.status*/});
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
  ...config.arweave,
  timeout: 20000,
  logging: true
});

let arweave;

if (parseInt(config.testmode)) {
  let testWeave;
  arweave = new Proxy({}, {
    get: (_, prop) => prop !== 'transactions' ? arweaveClient[prop] : new Proxy({}, {
      get: (_, txProp) => txProp !== 'getUploader' ? arweaveClient[prop][txProp] : async (upload, data) => {
        const uploader = await arweaveClient[prop][txProp](upload, data);
        return new Proxy({}, {
          get: (_, uploaderProp) => uploaderProp !== 'uploadChunk' ? uploader[uploaderProp] : async (...args) => {
            try {
              if (!testWeave) {
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
