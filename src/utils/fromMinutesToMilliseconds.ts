export const MILLISECONDS_IN_SECOND = 1000;
export const SECONDS_IN_MINUTE = 60;

export function fromMinutesToMilliseconds(inMinute: number) {
    return inMinute * MILLISECONDS_IN_SECOND * SECONDS_IN_MINUTE;
}
