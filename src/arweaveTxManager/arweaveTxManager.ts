import {arweave as arweaveInstance} from './arweave';
import config from 'config';
import {log} from '../utils/logger';

const key = JSON.parse(config.get('arweave.key'));

class ArweaveTxManager {
    private arweave = arweaveInstance;

    public async uploadChunk({chunkId, fileContent, tags}) {
        const transaction = await this.signTx(fileContent, tags);
        log.info(`For chunkId: ${chunkId} transaction ${transaction.id} has been signed`);
        const {id: txid} = await this.broadcastTx(transaction);
        log.info(`For chunkId: ${chunkId} transaction ${transaction.id} has been broadcasted`);
        const status = await this.arweave.transactions.getStatus(txid);
        return {status, txid};
    }

    protected async signTx(data, tags) {
        const transaction = await this.arweave.createTransaction({data}, key);
        for (const k in tags) {
            const v = tags[k];
            transaction.addTag(k, v);
        }
        await this.arweave.transactions.sign(transaction, key);
        return transaction;
    }

    protected async broadcastTx(transaction) {
        const uploader = await this.arweave.transactions.getUploader(transaction);
        while (!uploader.isComplete) {
            await uploader.uploadChunk();
        }
        return transaction;
    }

}

export const arweaveTxManager = new ArweaveTxManager();
