const signer = require('./signer');

module.exports = (_, router) => {
  router.get('/address', signer.address);
  router.get('/balance', signer.balance);
  router.all('/sign', signer.sign);
  router.post('/signPOST', signer.signPOST);
}
