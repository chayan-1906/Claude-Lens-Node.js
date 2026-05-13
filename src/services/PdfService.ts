import "colors";
import puppeteer, {Browser, Page, PDFOptions} from "puppeteer";
import SessionModel, {ISession} from "../models/Session";
import MessageModel, {IMessage} from "../models/Message";
import {IGeneratePdfParams, IGeneratePdfResponse} from "../types/session";
import {PDF_SLUG_NON_ALNUM_REGEX, PDF_SLUG_TRIM_DASHES_REGEX} from "../utils/constants";
import {generateFailureCode, generateInvalidCode, generateNotFoundCode} from "../utils/generateErrorCodes";
import {buildPageFooterTemplate, buildPageHeaderTemplate, buildSessionPdfHtml} from "../utils/pdfTemplate";

const SLUG_MAX_LENGTH: number = 60;
const SESSION_SHORT_LENGTH: number = 8;

class PdfService {
    static async generateSessionPdf({sessionId, includeThinking = false, includeTools = false}: IGeneratePdfParams): Promise<IGeneratePdfResponse> {
        console.log('Service: PdfService.generateSessionPdf called'.cyan.italic, {sessionId, includeThinking, includeTools});

        if (!sessionId) {
            console.debug('DEBUG: Missing sessionId'.cyan);
            return {error: generateInvalidCode('sessionId')};
        }

        const session: ISession | null = await SessionModel.findOne({sessionId});
        if (!session) {
            console.debug('DEBUG: Session not found'.cyan, {sessionId});
            return {error: generateNotFoundCode('session')};
        }

        const messages: IMessage[] = await MessageModel.find(
            {sessionInternalId: session._id},
            null,
            {sort: {timestamp: 1}},
        );
        console.debug('DEBUG: Messages loaded'.cyan, {sessionId, count: messages.length});

        try {
            const start: number = Date.now();
            const html: string = buildSessionPdfHtml(session, messages, {includeThinking, includeTools});
            const pdfBuffer: Buffer = await PdfService.renderToPdf(html, session);
            const filename: string = PdfService.buildFilename(session);
            const elapsedMs: number = Date.now() - start;

            console.log('Database: PDF generated'.cyan, {sessionId, bytes: pdfBuffer.length, filename, elapsedMs, messageCount: messages.length});
            return {pdfBuffer, filename};
        } catch (error: unknown) {
            console.error('Service Error: PDF generation failed'.red.bold, {sessionId, error: (error as Error).message});
            return {error: generateFailureCode('pdf_generation')};
        }
    }

    private static async renderToPdf(html: string, session: ISession): Promise<Buffer> {
        const browser: Browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const page: Page = await browser.newPage();
            await page.setJavaScriptEnabled(false);
            await page.setContent(html, {waitUntil: 'load'});

            const pdfOptions: PDFOptions = {
                format: 'A4',
                margin: {top: '24mm', bottom: '22mm', left: '20mm', right: '20mm'},
                displayHeaderFooter: true,
                headerTemplate: buildPageHeaderTemplate(session),
                footerTemplate: buildPageFooterTemplate(),
                printBackground: true,
            };

            const pdfBytes: Uint8Array = await page.pdf(pdfOptions);
            return Buffer.from(pdfBytes);
        } finally {
            await browser.close();
        }
    }

    private static buildFilename(session: ISession): string {
        const rawTitle: string = (session.title || '').toLowerCase();
        const slugged: string = rawTitle
            .replace(PDF_SLUG_NON_ALNUM_REGEX, '-')
            .replace(PDF_SLUG_TRIM_DASHES_REGEX, '')
            .slice(0, SLUG_MAX_LENGTH)
            .replace(PDF_SLUG_TRIM_DASHES_REGEX, '');
        const shortId: string = session.sessionId.slice(0, SESSION_SHORT_LENGTH);
        if (!slugged) {
            return `claude-lens-session-${shortId}.pdf`;
        }
        return `claude-lens-${slugged}-${shortId}.pdf`;
    }
}

export default PdfService;
