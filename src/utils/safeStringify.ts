export function safeStringify<E=any>(obj: E): string | E{
    try {
        return JSON.stringify(obj);
    } catch {
        return obj;
    }
}