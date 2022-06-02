export function splitBuffer(buffer: Uint8Array, partSize: number) {
    const parts: Uint8Array[] = [];
    let currentByte = 0;
    while (currentByte < buffer.length) {
        parts.push(buffer.slice(currentByte, currentByte += partSize));
    }
    return parts;
}
