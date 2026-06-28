# PDF Export — Implementation Plan

**Date:** 2026-05-13
**Spec:** `docs/superpowers/specs/2026-05-13-pdf-export-design.md`

## Tasks

### 1. Install dependencies

```
npm install puppeteer marked highlight.js
```

- Verify if `marked` and `highlight.js` ship their own TypeScript types. If not, install matching `@types/*` packages.
- Confirm Chromium downloads to `~/.cache/puppeteer/` (default).
- No `.puppeteerrc.cjs` will be added — default cache is intentional.

### 2. Add types

**File:** `src/types/session.ts`

Add two interfaces (kept beside existing session params/responses):

```ts
export interface IGeneratePdfParams {
    sessionId?: string;
    includeThinking?: boolean;
    includeTools?: boolean;
}

export interface IGeneratePdfResponse {
    pdfBuffer?: Buffer;
    filename?: string;
    error?: string;
}
```

No inline types anywhere — strict project rule.

### 3. Add PDF service

**New file:** `src/services/PdfService.ts`

Class `PdfService` with one public static method:

```ts
static async generateSessionPdf(params: IGeneratePdfParams): Promise<IGeneratePdfResponse>
```

Responsibilities (broken into private helpers inside the class):

- `loadSessionWithMessages(sessionId)` — fetches `ISession` and ordered `IMessage[]` from MongoDB. Returns `{ error }` on validation/not-found.
- `buildHtml(session, messages, options)` — assembles the full HTML document:
  - Inline CSS (sans-serif body, monospace code, header/footer styling, table for metadata strip, attachment badges).
  - Inline `highlight.js` CSS theme (light, embedded as a string).
  - Markdown rendering via `marked` (with code highlight callback that calls `highlight.js`).
  - Iterates messages, applies `includeThinking` / `includeTools` filters.
  - Renders attachments as filename badges (anchors when `r2Url` exists).
  - Escapes user-controlled strings appropriately when not flowing through `marked`.
- `renderToPdf(html)` — `puppeteer.launch({ headless: true, args: ['--no-sandbox'] })`, new page, `setContent`, `page.pdf(...)`, close browser. Returns `Buffer`.
- `buildFilename(session)` — slug from title + first 8 chars of `sessionId`, with empty-slug fallback.
- Timezone helper: `Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`.

Logging style: matches existing services (`Service: PdfService.<method> called`.cyan.italic, etc.).

### 4. Add controller

**File:** `src/controllers/SessionController.ts` (append a new exported function — consistent with the rest of the session-scoped routes).

`generateSessionPdfController(req, res)`:

- Read `sessionId` from `req.params`.
- Read `includeThinking` and `includeTools` from `req.query`. Each becomes `true` only when the string is `'true'` (case-insensitive); otherwise `false`.
- Call `PdfService.generateSessionPdf({ sessionId, includeThinking, includeTools })`.
- On `error`:
  - `invalid_sessionId` → 400.
  - `not_found_session` → 404.
  - `failure_pdf_generation` → 500.
  - Any other → 500.
  - Body: `ApiResponse` JSON (no PDF bytes).
- On success:
  - `res.setHeader('Content-Type', 'application/pdf')`.
  - `res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)`.
  - `res.end(pdfBuffer)`.
- Catch block: if headers already sent, `res.destroy()`. Else, 500 `ApiResponse`.

Add to the existing `export { ... }` list at the bottom of the file.

### 5. Wire route

**File:** `src/routes/SessionRoutes.ts`

Add:

```ts
router.get('/:sessionId/pdf', generateSessionPdfController);
```

Order does not affect correctness here (Express matches by exact path-segment structure), but place it after the existing `/:sessionId` GET for readability.

### 6. Verify

- Start the server (`npm run dev`).
- Hit:
  - `GET http://localhost:20261/api/v1/sessions/<realSessionId>/pdf` — opens / downloads a PDF.
  - `...?includeThinking=true` — thinking blocks appear.
  - `...?includeTools=true` — tool_use + tool_result cards appear.
  - `...?includeThinking=true&includeTools=true` — both appear.
  - `GET ...sessions/unknown-id/pdf` — 404 JSON.
  - `GET ...sessions//pdf` — 400 JSON (or 404 from Express if path collapses).
- Open the resulting PDF in Preview. Spot check:
  - Title and metadata header.
  - Chronological message order.
  - Markdown rendering (lists, headings, links).
  - Code blocks render in monospaced font, with highlighting when language detected.
  - Attachments show as badges with file names.
  - Page header / footer present from page 2 onward.

### 7. Code style audit

Before declaring complete:

- Single quotes everywhere except imports / directives.
- `export` / `export default` at the very bottom of every file.
- No inline types — every interface lives in `src/types/*`.
- No `any` / `unknown` unless documented why.
- Explicit `{}` on every `if`.
- Meaningful variable names in callbacks.
- Logs use the existing colored format.

## Files touched

- `package.json` (new deps).
- `package-lock.json` (auto).
- `src/types/session.ts` (two new interfaces).
- `src/services/PdfService.ts` (new file).
- `src/controllers/SessionController.ts` (one new controller appended).
- `src/routes/SessionRoutes.ts` (one new route line).

## Files NOT touched

- `src/models/*` (no schema changes).
- `src/utils/r2.ts` (no R2 changes).
- Any other service / controller.

## Open questions before coding

None — all resolved in chat 2026-05-13.
