import {Connection, Channel, ConsumeMessage, connect, Options} from 'amqplib';
import {log} from './logger';
import {safeStringify} from './safeStringify';
import config from 'config';

const queueCfg: { url: string } | undefined = config.get('queue');
interface QueueBrokerOptions {
  url?: string;
}

const defaultOptions = {url: `amqp://localhost`};

let resolver;

export class QueueBroker {

    connection?: Connection;
    rxChannel?: Channel;
    txChannel?: Channel;
    ready = new Promise((res) => {
        resolver = res;
    });
    constructor(private options: QueueBrokerOptions = defaultOptions) {
    }

    async connect() {
        const queueUrl = this.options.url as string;
        this.connection = await connect(queueUrl);
        log.info('Connected to queue');
        this.rxChannel = await this.connection.createChannel();
        this.txChannel = await this.connection.createChannel();
        resolver();
    }

    async ack(msg) {
        return this.rxChannel?.ack(msg);
    }

    async nack(msg, requeue: boolean) {
        return this.rxChannel?.nack(msg, false, requeue);
    }

    async subscribe(
        queueName: string,
        handler: (msg: ConsumeMessage | null) => void
    ) {
        await this.ready;
        log.info(`Subscribing to queue ${queueName}`);
        await this.rxChannel?.assertQueue(queueName);
        await this.rxChannel?.consume(queueName, handler);
    }

    async sendMessage(queueName: string, content: Record<any, any>, options?: Options.Publish) {
        await this.ready;
        log.info(`Sending message to ${queueName} with content ${safeStringify(content)}`);
        return this.txChannel?.sendToQueue(queueName,
            Buffer.from(JSON.stringify(content)), options);
    }

}

export const queueBroker = queueCfg ? new QueueBroker(queueCfg) : new QueueBroker();

queueBroker.connect();
