import {IMessage} from "../models/Message";
import {ISessionLine} from "../models/SessionLine";
import {IJsonlEntry} from "../types/sync";

function canBuildLosslessMongoJsonl(messages: IMessage[], sessionLines: ISessionLine[]): boolean {
    return sessionLines.length > 0 && messages.every((message: IMessage) => !!(message.rawLines && message.rawLines.length > 0));
}

function buildLosslessMongoJsonlLines(messages: IMessage[], sessionLines: ISessionLine[]): string[] {
    const messageEntries: IJsonlEntry[] = messages
        .filter((message: IMessage) => !!(message.rawLines && message.rawLines.length > 0))
        .map((message: IMessage, index: number) => ({
            lineIndex: message.startLineIndex ?? Number.MAX_SAFE_INTEGER,
            timestamp: new Date(message.timestamp as Date).getTime(),
            order: index,
            lines: message.rawLines as string[],
        }));

    const sessionLineEntries: IJsonlEntry[] = sessionLines.map((sessionLine: ISessionLine, index: number) => ({
        lineIndex: sessionLine.lineIndex,
        timestamp: Number.MIN_SAFE_INTEGER,
        order: messageEntries.length + index,
        lines: [sessionLine.line],
    }));

    return [...messageEntries, ...sessionLineEntries]
        .sort((a: IJsonlEntry, b: IJsonlEntry) => {
            if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
            if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
            return a.order - b.order;
        })
        .flatMap((entry: IJsonlEntry) => entry.lines);
}

export {buildLosslessMongoJsonlLines, canBuildLosslessMongoJsonl};
