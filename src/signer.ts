const Arweave = require('arweave');
const { ArweaveSigner, createData } = require('arbundles');
const AWS = require('aws-sdk');
const axios = require('axios');
const https = require('https');
const aws = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const key = require('../keystore/key.json');

const arweave = Arweave.init({
  port: 443,
  protocol: 'https',
  host: 'arweave.net',
});

const spacesEndpoint = new aws.Endpoint(process.env.AWS_HOST);
console.log(process.env.AWS_HOST);
const s3 = new aws.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET
});

console.log('AWS_HOST', process.env.AWS_HOST);

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: 'pointdisk',
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
        const url = 'https://pointdisk.fra1.digitaloceanspaces.com/'+name;

        const result = await new Promise((resolve, reject) => {
          try {
            https.get(url,function (res) {
              try {
                const body: Buffer[] = [];
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

module.exports = new Signer();
