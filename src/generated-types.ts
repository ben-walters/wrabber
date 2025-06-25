export namespace EventTypes {}

export interface EventDataMap {}

export const Events = {} as const;

export type EventName = keyof EventDataMap;
