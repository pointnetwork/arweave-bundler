import Arweave from 'arweave';
import config from 'config';
import TestWeave from 'testweave-sdk';
import {log} from './utils/logger';
import {safeStringify} from './utils/safeStringify';
const key = JSON.parse(config.get('arweave.key'));

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
                        } catch (e) {
                            log.fatal(`Message: ${e.message}, stack: ${safeStringify(e.stack)}`);
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

arweave.network.getInfo().then((info) => log.info(`Arweave network info: ${safeStringify(info)}`));

export {arweave};
