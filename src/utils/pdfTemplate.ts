import "colors";
import path from "path";
import hljs from "highlight.js";
import {Marked, MarkedExtension, Tokens} from "marked";
import {ISession} from "../models/Session";
import {IAttachmentMeta} from "../types/ws";
import {ContentBlock, EMessageRole, IMessage} from "../models/Message";
import {HTML_ESCAPE_AMP_REGEX, HTML_ESCAPE_DQUOTE_REGEX, HTML_ESCAPE_GT_REGEX, HTML_ESCAPE_LT_REGEX, HTML_ESCAPE_SQUOTE_REGEX} from "./constants";
import {IPdfRenderOptions, IPdfUserContentExtract, TPdfTextBlock, TPdfThinkingBlock, TPdfToolResultBlock, TPdfToolUseBlock} from "../types/session";

const HLJS_CSS: string = `
.hljs{color:#24292e;background:transparent}
.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}
.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}
.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}
.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}
.hljs-built_in,.hljs-symbol{color:#e36209}
.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}
.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}
.hljs-subst{color:#24292e}
.hljs-section{color:#005cc5;font-weight:700}
.hljs-bullet{color:#735c0f}
.hljs-emphasis{color:#24292e;font-style:italic}
.hljs-strong{color:#24292e;font-weight:700}
.hljs-addition{color:#22863a;background-color:#f0fff4}
.hljs-deletion{color:#b31d28;background-color:#ffeef0}
`;

const BASE_CSS: string = `
* { box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1a1a1a;
    font-size: 11pt;
    line-height: 1.5;
    margin: 0;
}
section.cover {
    margin-bottom: 24px;
    padding-bottom: 14px;
    border-bottom: 2px solid #e5e5e5;
}
section.cover h1 {
    font-size: 22pt;
    margin: 0 0 8px;
}
section.cover .description {
    color: #555;
    font-size: 11pt;
    margin-bottom: 14px;
}
.meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 16px;
    font-size: 9pt;
    color: #444;
    page-break-inside: avoid;
    margin: 0;
}
.meta dt {
    font-weight: 600;
    color: #666;
}
.meta dd {
    margin: 0;
}
.message {
    margin: 14px 0;
    padding: 12px 14px;
    border-radius: 6px;
    border: 1px solid #eee;
}
.message.user {
    background: #f6f8fb;
    border-color: #dbe3ee;
}
.message.assistant {
    background: #fff;
    border-color: #e5e5e5;
}
.message-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 8px;
    font-size: 9pt;
    color: #555;
}
.message-header .role {
    font-weight: 700;
    color: #222;
    font-size: 10pt;
}
.message-header .ts {
    font-family: ui-monospace, monospace;
    color: #888;
    font-size: 8.5pt;
}
.content { font-size: 10pt; }
.content p { margin: 6px 0; }
.content h1, .content h2, .content h3 { margin: 12px 0 6px; font-size: 11pt; }
.content h1 { font-size: 13pt; }
.content h2 { font-size: 12pt; }
.content ul, .content ol { padding-left: 22px; margin: 6px 0; }
.content li { margin: 2px 0; }
.content pre.code-block {
    background: #f6f8fa;
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: ui-monospace, monospace;
    font-size: 9pt;
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid #ecedf0;
}
.content code {
    font-family: ui-monospace, monospace;
    background: #f4f4f4;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 9pt;
}
.content pre.code-block code { background: transparent; padding: 0; }
.content blockquote {
    border-left: 3px solid #ddd;
    margin: 6px 0;
    padding: 0 12px;
    color: #555;
}
.content a { color: #0a58ca; text-decoration: underline; }
.thinking {
    border-left: 3px solid #c9a96e;
    margin: 8px 0;
    padding: 4px 10px;
    color: #6b5a32;
    font-style: italic;
    background: #fcf8ef;
    font-size: 9pt;
}
.thinking .label {
    font-weight: 700;
    margin-right: 6px;
    color: #927a3a;
}
.tool-card {
    border: 1px solid #d6e4ea;
    border-radius: 4px;
    padding: 8px 10px;
    margin: 8px 0;
    background: #f7fbfd;
    font-size: 9pt;
}
.tool-card.result { border-color: #d6ead6; background: #f7fdf9; }
.tool-card.result.is-error { border-color: #eacaca; background: #fdf6f6; }
.tool-card .tool-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
}
.tool-card .name {
    font-weight: 700;
    background: #2c5d72;
    color: #fff;
    padding: 1px 8px;
    border-radius: 3px;
    font-size: 8pt;
    display: inline-block;
}
.tool-card.result .name { background: #2c724d; }
.tool-card.result.is-error .name { background: #a23b3b; }
.tool-card .id {
    color: #888;
    font-size: 8pt;
    font-family: ui-monospace, monospace;
}
.tool-card .body {
    font-family: ui-monospace, monospace;
    font-size: 8.5pt;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: 6px;
    background: #fff;
    border: 1px solid #e3eaef;
    border-radius: 3px;
}
.attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}
.attachment {
    background: #ececec;
    border: 1px solid #ddd;
    border-radius: 3px;
    padding: 3px 8px;
    font-size: 8pt;
    color: #333;
    font-family: ui-monospace, monospace;
}
.attachment a { color: #0a58ca; text-decoration: none; }
.attachment .mime { color: #777; }
.token-usage {
    margin-top: 6px;
    font-size: 8pt;
    color: #888;
    font-style: italic;
}
`;

const getTimezone = (): string => {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const formatFullTimestamp = (when: Date, timezone: string): string => {
    return new Date(when).toLocaleString('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

const formatShortTime = (when: Date, timezone: string): string => {
    return new Date(when).toLocaleString('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

const escapeHtml = (text: string): string => {
    return text
        .replace(HTML_ESCAPE_AMP_REGEX, '&amp;')
        .replace(HTML_ESCAPE_LT_REGEX, '&lt;')
        .replace(HTML_ESCAPE_GT_REGEX, '&gt;')
        .replace(HTML_ESCAPE_DQUOTE_REGEX, '&quot;')
        .replace(HTML_ESCAPE_SQUOTE_REGEX, '&#39;');
}

const buildMarkdownInstance = (): Marked => {
    const extension: MarkedExtension = {
        async: false,
        gfm: true,
        breaks: false,
        renderer: {
            code({text, lang}: Tokens.Code): string {
                const requestedLang: string = lang ?? '';
                const language: string = requestedLang && hljs.getLanguage(requestedLang) ? requestedLang : 'plaintext';
                try {
                    const highlighted: string = hljs.highlight(text, {language, ignoreIllegals: true}).value;
                    return `<pre class="code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
                } catch (highlightError: unknown) {
                    const fallback: string = escapeHtml(text);
                    return `<pre class="code-block"><code>${fallback}</code></pre>`;
                }
            },
        },
    };
    return new Marked(extension);
}

const renderMarkdown = (text: string, markdown: Marked): string => {
    const result: string | Promise<string> = markdown.parse(text);
    if (typeof result === 'string') {
        return result;
    }
    console.warn('WARN: marked.parse returned a Promise unexpectedly — falling back to escaped text'.yellow);
    return escapeHtml(text);
}

const buildAttachmentsHtml = (attachments: IAttachmentMeta[] | undefined): string => {
    if (!attachments || attachments.length === 0) {
        return '';
    }
    const items: string[] = attachments.map((attachment: IAttachmentMeta) => {
        const name: string = escapeHtml(attachment.name);
        const mime: string = escapeHtml(attachment.mimeType);
        const url: string = attachment.r2Url ? escapeHtml(attachment.r2Url) : '';
        const label: string = url ? `<a href="${url}">${name}</a>` : name;
        return `<span class="attachment">${label} <span class="mime">— ${mime}</span></span>`;
    });
    return `<div class="attachments">${items.join('')}</div>`;
}

const buildToolUseHtml = (block: TPdfToolUseBlock): string => {
    const name: string = escapeHtml(block.name);
    const id: string = escapeHtml(block.id);
    const inputJson: string = escapeHtml(JSON.stringify(block.input, null, 2));
    return `<div class="tool-card use">
        <div class="tool-head"><span class="name">${name}</span><span class="id">${id}</span></div>
        <pre class="body">${inputJson}</pre>
    </div>`;
}

const buildToolResultHtml = (block: TPdfToolResultBlock): string => {
    const errorClass: string = block.is_error ? ' is-error' : '';
    const id: string = escapeHtml(block.tool_use_id);
    const label: string = block.is_error ? 'tool_result (error)' : 'tool_result';
    let body: string;
    if (typeof block.content === 'string') {
        body = escapeHtml(block.content);
    } else {
        body = escapeHtml(JSON.stringify(block.content, null, 2));
    }
    return `<div class="tool-card result${errorClass}">
        <div class="tool-head"><span class="name">${label}</span><span class="id">${id}</span></div>
        <pre class="body">${body}</pre>
    </div>`;
}

const buildThinkingHtml = (block: TPdfThinkingBlock, markdown: Marked): string => {
    const thinkingText: string = typeof block.thinking === 'string' ? block.thinking.trim() : '';
    if (!thinkingText) {
        return '';
    }
    const rendered: string = renderMarkdown(thinkingText, markdown);
    return `<div class="thinking"><span class="label">Thinking:</span>${rendered}</div>`;
}

const buildTextHtml = (block: TPdfTextBlock, markdown: Marked): string => {
    return renderMarkdown(block.text, markdown);
}

const buildAssistantMessageHtml = (message: IMessage, options: IPdfRenderOptions, markdown: Marked, tz: string): string => {
    const blocks: ContentBlock[] = Array.isArray(message.content) ? message.content as ContentBlock[] : [];
    const parts: string[] = [];

    for (const block of blocks) {
        let rendered: string = '';
        if (block.type === 'text') {
            rendered = buildTextHtml(block, markdown);
        } else if (block.type === 'thinking' && options.includeThinking) {
            rendered = buildThinkingHtml(block, markdown);
        } else if (block.type === 'tool_use' && options.includeTools) {
            rendered = buildToolUseHtml(block);
        } else if (block.type === 'tool_result' && options.includeTools) {
            rendered = buildToolResultHtml(block);
        }
        if (rendered.length > 0) {
            parts.push(rendered);
        }
    }

    if (parts.length === 0) {
        return '';
    }

    const ts: string = formatShortTime(message.timestamp, tz);
    const modelLabel: string = message.aiModel ? ` · ${escapeHtml(message.aiModel)}` : '';
    const inputTokens: number | undefined = typeof message.tokenUsage?.input === 'number' ? message.tokenUsage.input : undefined;
    const outputTokens: number | undefined = typeof message.tokenUsage?.output === 'number' ? message.tokenUsage.output : undefined;
    const tokenLine: string = (inputTokens !== undefined && outputTokens !== undefined)
        ? `<div class="token-usage">input ${inputTokens} · output ${outputTokens}</div>`
        : '';

    return `<div class="message assistant">
        <div class="message-header">
            <span class="role">Assistant${modelLabel}</span>
            <span class="ts">${ts} ${escapeHtml(tz)}</span>
        </div>
        <div class="content">${parts.join('')}</div>
        ${tokenLine}
    </div>`;
}

const extractUserContent = (message: IMessage): IPdfUserContentExtract => {
    if (typeof message.content === 'string') {
        return {bodyText: message.content, derivedAttachments: [], toolResultBlocks: []};
    }
    if (!Array.isArray(message.content)) {
        return {bodyText: '', derivedAttachments: [], toolResultBlocks: []};
    }

    const textParts: string[] = [];
    const derivedAttachments: IAttachmentMeta[] = [];
    const toolResultBlocks: TPdfToolResultBlock[] = [];

    for (const rawBlock of message.content as Record<string, unknown>[]) {
        const blockType: string = typeof rawBlock.type === 'string' ? rawBlock.type : '';

        if (blockType === 'text' && typeof rawBlock.text === 'string') {
            const textValue: string = rawBlock.text;
            if (textValue.startsWith('File attached:')) {
                const dashParts: string[] = textValue.split(' — ');
                if (dashParts.length >= 2) {
                    const fileName: string = dashParts[0].replace(/^File attached:\s*/, '').trim();
                    const fileUrl: string = dashParts[dashParts.length - 1].trim();
                    derivedAttachments.push({name: fileName, mimeType: 'file', size: 0, r2Url: fileUrl});
                    continue;
                }
            }
            textParts.push(textValue);
        } else if (blockType === 'image' || blockType === 'document') {
            const source: Record<string, unknown> | undefined = rawBlock.source as Record<string, unknown> | undefined;
            if (!source) {
                continue;
            }
            const mediaType: string = typeof source.media_type === 'string'
                ? source.media_type
                : (blockType === 'image' ? 'image' : 'document');
            let attachmentUrl: string = '';
            let attachmentName: string = `(${blockType})`;
            if (source.type === 'url' && typeof source.url === 'string') {
                attachmentUrl = source.url;
                try {
                    const parsedName: string = path.basename(new URL(attachmentUrl).pathname);
                    if (parsedName) {
                        attachmentName = parsedName;
                    }
                } catch (parseError: unknown) {
                    // keep default attachmentName
                }
            }
            derivedAttachments.push({name: attachmentName, mimeType: mediaType, size: 0, r2Url: attachmentUrl});
        } else if (blockType === 'tool_result') {
            toolResultBlocks.push(rawBlock as unknown as TPdfToolResultBlock);
        }
    }

    return {bodyText: textParts.join('\n\n'), derivedAttachments, toolResultBlocks};
}

const buildUserMessageHtml = (message: IMessage, markdown: Marked, tz: string, options: IPdfRenderOptions): string => {
    const {bodyText, derivedAttachments, toolResultBlocks} = extractUserContent(message);
    const explicitAttachments: IAttachmentMeta[] = message.attachments ?? [];
    const finalAttachments: IAttachmentMeta[] = explicitAttachments.length > 0 ? explicitAttachments : derivedAttachments;

    const trimmedBody: string = bodyText.trim();
    const hasBody: boolean = trimmedBody.length > 0;
    const hasAttachments: boolean = finalAttachments.length > 0;
    const renderedToolResults: string[] = options.includeTools
        ? toolResultBlocks.map((block: TPdfToolResultBlock) => buildToolResultHtml(block))
        : [];
    const toolResultsHtml: string = renderedToolResults.join('');

    if (!hasBody && !hasAttachments && renderedToolResults.length === 0) {
        return '';
    }

    if (!hasBody && !hasAttachments) {
        return toolResultsHtml;
    }

    const body: string = hasBody ? renderMarkdown(trimmedBody, markdown) : '';
    const ts: string = formatShortTime(message.timestamp, tz);
    const attachmentsHtml: string = buildAttachmentsHtml(finalAttachments);

    return `<div class="message user">
        <div class="message-header">
            <span class="role">You</span>
            <span class="ts">${ts} ${escapeHtml(tz)}</span>
        </div>
        <div class="content">${body}</div>
        ${attachmentsHtml}
        ${toolResultsHtml}
    </div>`;
}

const buildSessionPdfHtml = (session: ISession, messages: IMessage[], options: IPdfRenderOptions): string => {
    const timezone: string = getTimezone();
    const markdown: Marked = buildMarkdownInstance();

    const projectName: string = path.basename(session.rawProjectDir);
    const createdAt: string = formatFullTimestamp(session.createdAt, timezone);
    const generatedAt: string = formatFullTimestamp(new Date(), timezone);

    const titleHtml: string = escapeHtml(session.title || 'Untitled Session');
    const descriptionHtml: string = session.description
        ? `<div class="description">${escapeHtml(session.description)}</div>`
        : '';

    const metaRows: Array<[string, string]> = [
        ['Model', session.aiModel ?? '—'],
        ['Project', projectName || '—'],
        ['Git branch', session.gitBranch ?? '—'],
        ['Source', session.source],
        ['Created at', createdAt],
        ['Messages', String(messages.length)],
        ['Generated at', `${generatedAt} (${timezone})`],
    ];
    const metaHtml: string = metaRows
        .map(([metaKey, metaValue]: [string, string]) => `<dt>${escapeHtml(metaKey)}</dt><dd>${escapeHtml(metaValue)}</dd>`)
        .join('');

    const bodyHtml: string = messages.map((message: IMessage) => {
        if (message.role === EMessageRole.USER) {
            return buildUserMessageHtml(message, markdown, timezone, options);
        }
        return buildAssistantMessageHtml(message, options, markdown, timezone);
    }).filter((part: string) => part.length > 0).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${titleHtml}</title>
<style>
${BASE_CSS}
${HLJS_CSS}
</style>
</head>
<body>
    <section class="cover">
        <h1>${titleHtml}</h1>
        ${descriptionHtml}
        <dl class="meta">${metaHtml}</dl>
    </section>
    <section class="body">
        ${bodyHtml}
    </section>
</body>
</html>`;
}

const buildPageHeaderTemplate = (session: ISession): string => {
    const titleEscaped: string = escapeHtml(session.title || 'Untitled Session');
    return `<div style="font-size:8pt;color:#888;width:100%;padding:0 20mm;display:flex;justify-content:space-between;"><span>${titleEscaped}</span><span>page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}

const buildPageFooterTemplate = (): string => {
    const timezone: string = getTimezone();
    const generatedAt: string = formatFullTimestamp(new Date(), timezone);
    const footerLine: string = escapeHtml(`Generated by Claude Lens — ${generatedAt} (${timezone})`);
    return `<div style="font-size:8pt;color:#888;width:100%;padding:0 20mm;text-align:center;">${footerLine}</div>`;
}

export {buildSessionPdfHtml, buildPageHeaderTemplate, buildPageFooterTemplate};
