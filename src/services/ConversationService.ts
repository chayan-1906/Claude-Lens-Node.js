import "colors";
import MessageModel from "../models/Message";
import ConversationModel, {IConversation} from "../models/Conversation";
import {generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {IGetAllConversationsParams, IGetAllConversationsResponse, IGetSessionResponse, IPagination} from "../types/conversation";

class ConversationService {
    static async getAllConversations({title, source, projectDir, page = 1, limit = 20}: IGetAllConversationsParams): Promise<IGetAllConversationsResponse> {
        console.log('Service: ConversationService.getAllConversations called'.cyan.italic);

        const filter: Record<string, unknown> = {};
        if (title) filter.title = {$regex: title, $options: 'i'};
        if (source) filter.source = source;
        if (projectDir) filter.projectDir = projectDir;

        const skip: number = (page - 1) * limit;

        const [conversations, total]: [IConversation[], number] = await Promise.all([
            ConversationModel.find(filter, {sessionId: 1, title: 1, aiModel: 1, projectDir: 1, source: 1, createdAt: 1, updatedAt: 1})
                .sort({updatedAt: -1})
                .skip(skip)
                .limit(limit),
            ConversationModel.countDocuments(filter),
        ]);

        console.log('Database: Conversations fetched'.cyan, conversations.length);

        const pagination: IPagination = {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        };

        return {conversations, pagination};
    }

    static async getSessionBySessionId(sessionId: string): Promise<IGetSessionResponse> {
        console.log('Service: ConversationService.getSessionBySessionId called'.cyan.italic);

        if (!sessionId) {
            return {error: generateInvalidCode('sessionId')};
        }

        const conversation: IConversation | null = await ConversationModel.findOne({sessionId});
        if (!conversation) {
            return {error: generateNotFoundCode('session')};
        }

        const messages = await MessageModel.find({conversationId: conversation._id}).sort({timestamp: 1});
        console.log('Database: Session fetched'.cyan, {sessionId, messages: messages.length});

        return {conversation, messages};
    }
}

export default ConversationService;
