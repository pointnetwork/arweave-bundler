import {keccak256} from 'ethereumjs-util';

export function hashFn(buf: Buffer) {
    return Buffer.from(keccak256(buf) as unknown as string, 'hex'); //.slice(-20);
}
