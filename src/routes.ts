import signer from './signer';
import bodyParser from 'body-parser';

export default (_, router) => {
    router.get('/health', signer.health.bind(signer));
    router.get('/address', signer.address.bind(signer));
    router.get('/balance', signer.balance.bind(signer));
    router.all('/sign', signer.sign.bind(signer));
    router.post('/signPOST', signer.signPOST.bind(signer));
    router.post('/signPOST2',  bodyParser.json(), signer.signPOST2.bind(signer));
    router.get('/download/:chunkId', signer.getFileFromS3Route.bind(signer));
    router.get('/txs', signer.chunkIdTxsRoute.bind(signer));
};
