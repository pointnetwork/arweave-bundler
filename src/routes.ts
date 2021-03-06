import signer from './signer';

export default (_, router) => {
    router.get('/health', signer.health.bind(signer));
    router.get('/address', signer.address.bind(signer));
    router.get('/balance', signer.balance.bind(signer));
    router.all('/sign', signer.sign.bind(signer));
    router.post('/signPOST', signer.signPOST.bind(signer));
    router.get('/download/:chunkId', signer.getFileFromS3Route.bind(signer));
    router.get('/is_uploaded/:chunkId', signer.isUploaded.bind(signer));
    router.get('/txs', signer.chunkIdTxsRoute.bind(signer));
};
