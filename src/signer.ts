import Arweave from 'arweave';
import https from 'https';
import aws from 'aws-sdk';
import multer from 'multer';
import multerS3 from 'multer-s3';
import config from 'config';

const key = require(config.keystore);

const arweave = Arweave.init(config.arweave);

const spacesEndpoint = new aws.Endpoint(`${config.s3.protocol}://${config.s3.host}`);

const s3 = new aws.S3({
  // region: 'us-east-1'
  endpoint: spacesEndpoint,
  accessKeyId: config.s3.key,
  secretAccessKey: config.s3.secret
});

console.log('AWS_HOST', `${config.s3.protocol}://${config.s3.host}`);

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: config.s3.bucket,
    acl: 'public-read',
    key: function (request, _, cb) {
      // console.log('multer inside key function', {request, file: _, cb});
      const name = readableRandomStringMaker(20);
      request.__name = name;
      cb(null, name);
    }
  })
}).array('file', 1);

class Signer {
  async signPOST(request, response) {
    const cb = async(request, response, resolve, reject, error) => {
      try {
        if (error) {
          console.log(error);
          reject(error);
        }

        const name = request.__name;
        const url = `${config.s3.protocol}://${config.s3.bucket}${config.s3.host}/${name}`;

        const result = await new Promise((resolve, reject) => {
          try {
            https.get(url,function (res) {
              try {
                const body: Uint8Array[] = [];
                res.on('data', function (chunk) { body.push(chunk); });
                res.on('end', function () { resolve(Buffer.concat(body)); });
              } catch(e) { reject(e); }
            });
          } catch(e) { reject(e); }
        });

        const dataToSign = result;
        const tagsToSign = this.getTagsFromRequest(request);
        let transaction = await this.signTx(dataToSign, tagsToSign);
        transaction = await this.broadcastTx(transaction);

        response.json({'status':'ok', 'code': 200, 'txid': transaction.id /*, 'bundler_response_status': response.status */ });
        resolve(response);
      } catch(e) {
        reject(e);
      }
    };

    return await new Promise((resolve, reject) => {
      try {
        upload(request, response, cb.bind(this, request, response, resolve, reject));
      } catch(e) { reject(e); }
    })
  }

  getKey() {
    return key;
  }

  async keyToAddress(key) {
    // Get the wallet address for a private key
    return await arweave.wallets.jwkToAddress(key);
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
    while (!uploader.isComplete) { await uploader.uploadChunk(); }

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

export default new Signer();
