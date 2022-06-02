import {arweave as arweaveInstance} from './arweave';
import config from 'config';
import {log} from '../utils/logger';
import retry from 'async-retry';
import {safeStringify} from '../utils/safeStringify';
export const DEFAULT_RETRY_POLICY = {
    retries: 5,
    minTimeout: 3000
};

const key = JSON.parse(config.get('arweave.key'));
const OK_STATUSES = [200, 201, 202];

class ArweaveTxManager {
    private arweave = arweaveInstance;
    private transactions = Object.create(null);
    private chunks = Object.create(null);

    public getTxsInfo() {
        return {
            txs: this.transactions,
            chunkIds: this.chunks
        };
    }

    public async uploadChunk({chunkId, fileContent, tags}) {
        const transaction = await this.signTx(fileContent, tags, chunkId);
        log.info(`For chunkId: ${chunkId} transaction ${transaction.id} has been signed`);
        try {
            const {id: txid} = await retry(async () => this.broadcastTx(transaction),
                DEFAULT_RETRY_POLICY);
            log.info(`For chunkId: ${chunkId} transaction ${transaction.id} has been broadcasted`);
            const status = await retry(async () => {
                const statusResponse = await this.arweave.transactions.getStatus(txid);
                this.transactions[transaction.id].statusHistory.push(statusResponse);
                if (OK_STATUSES.includes(statusResponse.status)) {
                    return statusResponse;
                } else {
                    const errMsg = `For chunkId ${chunkId} with tx: ${txid} the status response was not good: ${safeStringify(statusResponse)}. It will retry`;
                    log.error(errMsg);
                    throw new Error(errMsg);
                }
            },
            DEFAULT_RETRY_POLICY);
            return {status, txid};
        } catch (error) {
            this.transactions[transaction.id].error = error;
            throw error;
        }

    }

    protected async signTx(data, tags, chunkId) {
        const transaction = await this.arweave.createTransaction({data}, key);
        for (const k in tags) {
            const v = tags[k];
            transaction.addTag(k, v);
        }
        await this.arweave.transactions.sign(transaction, key);
        this.chunks[chunkId] = this.chunks[chunkId]?.concat(transaction.id) || [transaction.id];
        this.transactions[transaction.id] = {signedAt: Date.now(), chunkId, statusHistory: []};
        return transaction;
    }

    protected async broadcastTx(transaction) {
        const uploader = await this.arweave.transactions.getUploader(transaction);
        while (!uploader.isComplete) {
            await uploader.uploadChunk();
        }
        this.transactions[transaction.id].fileUploadedAt = Date.now();
        return transaction;
    }

}

export const arweaveTxManager = new ArweaveTxManager();
