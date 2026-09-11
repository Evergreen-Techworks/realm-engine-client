export interface ChatEvent {
    sender: string;
    /** Server TEXT source object; omitted for outgoing or source-less messages. */
    sourceObjectId?: number;
    message: string;
    channel: ChatChannel;
    isLocal: boolean;
    /** True when this event is the server TEXT echo of a message we already processed via PLAYERTEXT. */
    isEcho: boolean;
    timestamp: number;
}

export type ChatChannel =
    | 'say'
    | 'yell'
    | 'party'
    | 'guild'
    | 'tell'
    | 'global'
    | 'system'
    | 'unknown';

export type ChatHandler = (event: ChatEvent) => void;
export type Unsubscribe = () => void;

/** How `chat.blockOutgoing` matches the raw outgoing `PLAYERTEXT` line (client-typed chat only). */
export type ChatOutgoingBlockMode = 'equals' | 'contains';
