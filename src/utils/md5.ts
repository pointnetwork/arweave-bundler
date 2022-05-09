import crypto, {BinaryLike} from 'crypto';

export function md5(contents: string | BinaryLike): string {
    return crypto.createHash('md5').update(contents).digest('hex');
}
