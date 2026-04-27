# Search Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-stack search feature to Claude Lens — MongoDB `$text` search on the backend, debounced command-palette modal on the frontend, with three scopes: session, project, and global.

**Architecture:** Backend exposes `GET /api/v1/search` handled by a thin `SearchController` → `SearchService` which runs parallel `$text` queries across relevant models. Frontend renders a `SearchModal` opened by contextual `HiOutlineSearch` icon buttons in the header (global), sidebar (project), and session toolbar (session), wired through a debounced `useSearch` hook and a Next.js server action.

**Tech Stack:** Node.js + TypeScript + Mongoose (`$text` indexes) on backend; Next.js 16 App Router + React hooks + Tailwind CSS + react-icons (HiOutline) on frontend. No new dependencies needed.

---

## File Map

### Backend — create
- `project/src/types/search.ts` — `ISearchQuery`, result interfaces, `ISearchResponse`
- `project/src/services/SearchService.ts` — all `$text` query logic, snippet extraction
- `project/src/controllers/SearchController.ts` — HTTP validation + delegates to service
- `project/src/routes/SearchRoutes.ts` — mounts `GET /` → controller

### Backend — modify
- `project/src/models/Message.ts` — add text index on `content`, `content.text`, `content.thinking`
- `project/src/models/Session.ts` — add text index on `title`, `description`, `slug`
- `project/src/models/Task.ts` — add text index on `subject`, `description`
- `project/src/models/Memory.ts` — add text index on `content`, `filePath`
- `project/src/server.ts` — import and register `searchRoutes` at `/api/v1/search`

### Frontend — create
- `src/types/search.ts` — `ISearchResult` union, `ISearchResults`, `ISearchResponse`, params types
- `src/actions/search.actions.ts` — Next.js server action calling `GET /api/v1/search`
- `src/hooks/useSearch.ts` — debounced (300ms) search hook with loading/error state
- `src/components/SearchModal.tsx` — full command-palette overlay with chips + result list

### Frontend — modify
- `src/utils/apis.ts` — add `searchApi` URL builder
- `src/components/layouts/AppLayout.tsx` — global search `HiOutlineSearch` button in header toolbar
- `src/components/SidebarClient.tsx` — per-project `HiOutlineSearch` button next to each project name
- `src/components/ChatSessionView.tsx` — session `HiOutlineSearch` button in session toolbar

---

## Task 1: Backend — Search Types

**Files:**
- Create: `project/src/types/search.ts`

- [ ] **Step 1: Create the types file**

```typescript
export interface ISearchQuery {
    q: string;
    scope: 'session' | 'project' | 'global';
    sessionId?: string;
    projectDir?: string;
    limit?: number;
    skip?: number;
}

export interface ISearchMessageResult {
    _type: 'message';
    messageId: string;
    snippet: string;
    role: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
    timestamp: string;
}

export interface ISearchSessionResult {
    _type: 'session';
    sessionId: string;
    snippet: string;
    title: string;
    description?: string;
    projectDir: string;
    updatedAt: string;
}

export interface ISearchTaskResult {
    _type: 'task';
    taskInternalId: string;
    snippet: string;
    subject: string;
    status: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
}

export interface ISearchMemoryResult {
    _type: 'memory';
    memoryId: string;
    snippet: string;
    filePath: string;
    projectDir: string;
}

export type ISearchResult =
    | ISearchMessageResult
    | ISearchSessionResult
    | ISearchTaskResult
    | ISearchMemoryResult;

export interface ISearchResults {
    messages: ISearchMessageResult[];
    sessions: ISearchSessionResult[];
    tasks: ISearchTaskResult[];
    memories: ISearchMemoryResult[];
}

export interface ISearchResponse {
    success: boolean;
    results?: ISearchResults;
    totalCount?: number;
    error?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add project/src/types/search.ts
git commit -m "feat(search): add backend search type definitions"
```

---

## Task 2: Backend — Add MongoDB Text Indexes

**Files:**
- Modify: `project/src/models/Message.ts`
- Modify: `project/src/models/Session.ts`
- Modify: `project/src/models/Task.ts`
- Modify: `project/src/models/Memory.ts`

- [ ] **Step 1: Add text index to Message.ts**

Add after the existing `MessageSchema.index({sessionInternalId: 1, timestamp: 1});` line at line 138:

```typescript
MessageSchema.index({'content': 'text', 'content.text': 'text', 'content.thinking': 'text'});
```

The `content` path indexes string user messages; `content.text` indexes TextBlock assistant messages; `content.thinking` indexes ThinkingBlock content.

- [ ] **Step 2: Add text index to Session.ts**

Add after the `SessionSchema` definition closes (before `const SessionModel`):

```typescript
SessionSchema.index({title: 'text', description: 'text', slug: 'text'});
```

- [ ] **Step 3: Add text index to Task.ts**

Add after the existing `TaskSchema.index({sessionId: 1, taskId: 1}, {unique: true});` line:

```typescript
TaskSchema.index({subject: 'text', description: 'text'});
```

- [ ] **Step 4: Add text index to Memory.ts**

Add after the existing `MemorySchema.index({projectDir: 1, filePath: 1}, {unique: true});` line:

```typescript
MemorySchema.index({content: 'text', filePath: 'text'});
```

- [ ] **Step 5: Restart the backend and verify indexes created in Atlas**

Run: `npm run dev` in `project/`

In MongoDB Atlas → Collections → each model's Indexes tab, confirm the new `text` indexes appear (they build in the background on first use).

- [ ] **Step 6: Commit**

```bash
git add project/src/models/Message.ts project/src/models/Session.ts project/src/models/Task.ts project/src/models/Memory.ts
git commit -m "feat(search): add MongoDB text indexes to Message, Session, Task, Memory"
```

---

## Task 3: Backend — SearchService

**Files:**
- Create: `project/src/services/SearchService.ts`

The service exports one static method `search(query)` that fans out to parallel sub-queries based on scope, then merges results. It also exports a `extractSnippet` helper (pure function, easy to test manually).

- [ ] **Step 1: Create `project/src/services/SearchService.ts`**

```typescript
import "colors";
import {Types} from "mongoose";
import TaskModel from "../models/Task";
import MemoryModel from "../models/Memory";
import SessionModel from "../models/Session";
import MessageModel, {ContentBlock, TextBlock, ThinkingBlock} from "../models/Message";
import {ISearchMemoryResult, ISearchMessageResult, ISearchQuery, ISearchResults, ISearchSessionResult, ISearchTaskResult} from "../types/search";

const SNIPPET_LEN = 150;

function extractTextFromContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
        .filter((b): b is TextBlock | ThinkingBlock => b.type === 'text' || b.type === 'thinking')
        .map((b) => b.type === 'text' ? b.text : b.thinking)
        .join(' ');
}

function makeSnippet(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= SNIPPET_LEN) return trimmed;
    return trimmed.slice(0, SNIPPET_LEN).trimEnd() + '…';
}

class SearchService {
    static async search({q, scope, sessionId, projectDir, limit = 20, skip = 0}: ISearchQuery): Promise<ISearchResults> {
        console.log('Service: SearchService.search called'.cyan.italic, {q, scope, sessionId, projectDir, limit, skip});

        const safeLimit = Math.min(50, Math.max(1, limit));
        const safeSkip = Math.max(0, skip);

        switch (scope) {
            case 'session':
                return SearchService._searchSession(q, sessionId!, safeLimit, safeSkip);
            case 'project':
                return SearchService._searchProject(q, projectDir!, safeLimit, safeSkip);
            default:
                return SearchService._searchGlobal(q, safeLimit, safeSkip);
        }
    }

    private static async _searchSession(q: string, sessionId: string, limit: number, skip: number): Promise<ISearchResults> {
        const session = await SessionModel.findOne({sessionId}, 'sessionId title projectDir').lean();
        if (!session) return SearchService._empty();

        const sessionOid: Types.ObjectId = session._id as Types.ObjectId;

        const [msgs, tasks] = await Promise.all([
            MessageModel.find(
                {$text: {$search: q}, sessionInternalId: sessionOid},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            TaskModel.find(
                {$text: {$search: q}, sessionId},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        const messages: ISearchMessageResult[] = msgs.map((m) => ({
            _type: 'message' as const,
            messageId: String(m._id),
            snippet: makeSnippet(extractTextFromContent(m.content as string | ContentBlock[])),
            role: m.role,
            sessionId: session.sessionId,
            sessionTitle: session.title,
            projectDir: session.projectDir,
            timestamp: m.timestamp.toISOString(),
        }));

        const taskResults: ISearchTaskResult[] = tasks.map((t) => ({
            _type: 'task' as const,
            taskInternalId: String(t._id),
            snippet: makeSnippet(t.description),
            subject: t.subject,
            status: t.status,
            sessionId: session.sessionId,
            sessionTitle: session.title,
            projectDir: session.projectDir,
        }));

        return {messages, sessions: [], tasks: taskResults, memories: []};
    }

    private static async _searchProject(q: string, projectDir: string, limit: number, skip: number): Promise<ISearchResults> {
        const projectSessions = await SessionModel.find({projectDir}, 'sessionId title projectDir').lean();
        const sessionOids: Types.ObjectId[] = projectSessions.map((s) => s._id as Types.ObjectId);
        const sessionIdStrings: string[] = projectSessions.map((s) => s.sessionId);
        const sessionMap = new Map(projectSessions.map((s) => [s.sessionId, s]));
        const oidToSession = new Map(projectSessions.map((s) => [String(s._id), s]));

        const [msgs, sessionDocs, tasks, memories] = await Promise.all([
            sessionOids.length > 0
                ? MessageModel.find(
                    {$text: {$search: q}, sessionInternalId: {$in: sessionOids}},
                    {score: {$meta: 'textScore'}},
                ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean()
                : Promise.resolve([]),
            SessionModel.find(
                {$text: {$search: q}, projectDir},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            sessionIdStrings.length > 0
                ? TaskModel.find(
                    {$text: {$search: q}, sessionId: {$in: sessionIdStrings}},
                    {score: {$meta: 'textScore'}},
                ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean()
                : Promise.resolve([]),
            MemoryModel.find(
                {$text: {$search: q}, projectDir},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        const messages: ISearchMessageResult[] = msgs.map((m) => {
            const s = oidToSession.get(String(m.sessionInternalId));
            return {
                _type: 'message' as const,
                messageId: String(m._id),
                snippet: makeSnippet(extractTextFromContent(m.content as string | ContentBlock[])),
                role: m.role,
                sessionId: s?.sessionId ?? '',
                sessionTitle: s?.title ?? '',
                projectDir,
                timestamp: m.timestamp.toISOString(),
            };
        });

        const sessions: ISearchSessionResult[] = sessionDocs.map((s) => ({
            _type: 'session' as const,
            sessionId: s.sessionId,
            snippet: makeSnippet(s.description ?? s.title),
            title: s.title,
            description: s.description,
            projectDir: s.projectDir,
            updatedAt: s.updatedAt.toISOString(),
        }));

        const taskResults: ISearchTaskResult[] = tasks.map((t) => {
            const s = sessionMap.get(t.sessionId);
            return {
                _type: 'task' as const,
                taskInternalId: String(t._id),
                snippet: makeSnippet(t.description),
                subject: t.subject,
                status: t.status,
                sessionId: t.sessionId,
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? projectDir,
            };
        });

        const memoryResults: ISearchMemoryResult[] = memories.map((mem) => ({
            _type: 'memory' as const,
            memoryId: String(mem._id),
            snippet: makeSnippet(mem.content),
            filePath: mem.filePath,
            projectDir: mem.projectDir,
        }));

        return {messages, sessions, tasks: taskResults, memories: memoryResults};
    }

    private static async _searchGlobal(q: string, limit: number, skip: number): Promise<ISearchResults> {
        const [msgs, sessionDocs, tasks, memories] = await Promise.all([
            MessageModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit)
                .populate<{sessionInternalId: {_id: Types.ObjectId; sessionId: string; title: string; projectDir: string}}>('sessionInternalId', 'sessionId title projectDir')
                .lean(),
            SessionModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            TaskModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
            MemoryModel.find(
                {$text: {$search: q}},
                {score: {$meta: 'textScore'}},
            ).sort({score: {$meta: 'textScore'}}).skip(skip).limit(limit).lean(),
        ]);

        // Batch-fetch sessions for task results
        const taskSessionIds = [...new Set(tasks.map((t) => t.sessionId))];
        const taskSessions = taskSessionIds.length > 0
            ? await SessionModel.find({sessionId: {$in: taskSessionIds}}, 'sessionId title projectDir').lean()
            : [];
        const taskSessionMap = new Map(taskSessions.map((s) => [s.sessionId, s]));

        const messages: ISearchMessageResult[] = msgs.map((m) => {
            const s = m.sessionInternalId as unknown as {sessionId: string; title: string; projectDir: string} | null;
            return {
                _type: 'message' as const,
                messageId: String(m._id),
                snippet: makeSnippet(extractTextFromContent(m.content as string | ContentBlock[])),
                role: m.role,
                sessionId: s?.sessionId ?? '',
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? '',
                timestamp: m.timestamp.toISOString(),
            };
        });

        const sessions: ISearchSessionResult[] = sessionDocs.map((s) => ({
            _type: 'session' as const,
            sessionId: s.sessionId,
            snippet: makeSnippet(s.description ?? s.title),
            title: s.title,
            description: s.description,
            projectDir: s.projectDir,
            updatedAt: s.updatedAt.toISOString(),
        }));

        const taskResults: ISearchTaskResult[] = tasks.map((t) => {
            const s = taskSessionMap.get(t.sessionId);
            return {
                _type: 'task' as const,
                taskInternalId: String(t._id),
                snippet: makeSnippet(t.description),
                subject: t.subject,
                status: t.status,
                sessionId: t.sessionId,
                sessionTitle: s?.title ?? '',
                projectDir: s?.projectDir ?? '',
            };
        });

        const memoryResults: ISearchMemoryResult[] = memories.map((mem) => ({
            _type: 'memory' as const,
            memoryId: String(mem._id),
            snippet: makeSnippet(mem.content),
            filePath: mem.filePath,
            projectDir: mem.projectDir,
        }));

        return {messages, sessions, tasks: taskResults, memories: memoryResults};
    }

    private static _empty(): ISearchResults {
        return {messages: [], sessions: [], tasks: [], memories: []};
    }
}

export default SearchService;
```

- [ ] **Step 2: Commit**

```bash
git add project/src/services/SearchService.ts
git commit -m "feat(search): add SearchService with session/project/global scope logic"
```

---

## Task 4: Backend — Controller, Route, Register

**Files:**
- Create: `project/src/controllers/SearchController.ts`
- Create: `project/src/routes/SearchRoutes.ts`
- Modify: `project/src/server.ts`

- [ ] **Step 1: Create `project/src/controllers/SearchController.ts`**

```typescript
import "colors";
import {Request, Response} from "express";
import {ApiResponse} from "../utils/ApiResponse";
import SearchService from "../services/SearchService";
import {ISearchQuery} from "../types/search";

const VALID_SCOPES = ['session', 'project', 'global'] as const;

const searchController = async (req: Request, res: Response): Promise<void> => {
    console.info('Controller: searchController started'.bgBlue.white.bold);

    try {
        const {q, scope, sessionId, projectDir} = req.query as Record<string, string | undefined>;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const skip = Math.max(0, parseInt(req.query.skip as string) || 0);

        if (!q || q.trim().length < 2) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'INVALID_QUERY',
                errorMsg: 'q must be at least 2 characters',
            }));
            return;
        }

        if (!scope || !VALID_SCOPES.includes(scope as typeof VALID_SCOPES[number])) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'INVALID_SCOPE',
                errorMsg: `scope must be one of: ${VALID_SCOPES.join(', ')}`,
            }));
            return;
        }

        if (scope === 'session' && !sessionId) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'MISSING_SESSION_ID',
                errorMsg: 'sessionId is required when scope is "session"',
            }));
            return;
        }

        if (scope === 'project' && !projectDir) {
            res.status(400).send(new ApiResponse({
                success: false,
                errorCode: 'MISSING_PROJECT_DIR',
                errorMsg: 'projectDir is required when scope is "project"',
            }));
            return;
        }

        const query: ISearchQuery = {
            q: q.trim(),
            scope: scope as ISearchQuery['scope'],
            sessionId,
            projectDir,
            limit,
            skip,
        };

        const results = await SearchService.search(query);
        const totalCount = results.messages.length + results.sessions.length + results.tasks.length + results.memories.length;

        console.log('SUCCESS: Search completed'.bgGreen.bold, {q, scope, totalCount});
        res.status(200).send(new ApiResponse({
            success: true,
            message: 'Search completed',
            results,
            totalCount,
        }));
    } catch (error: any) {
        console.error('Controller Error: searchController failed'.red.bold, error);
        res.status(500).send(new ApiResponse({
            success: false,
            errorMsg: error.message || 'Something went wrong during search!',
        }));
    }
};

export {searchController};
```

- [ ] **Step 2: Create `project/src/routes/SearchRoutes.ts`**

```typescript
import {Router} from "express";
import {searchController} from "../controllers/SearchController";

const router: Router = Router();

router.get('/', searchController);

export default router;
```

- [ ] **Step 3: Register in `project/src/server.ts`**

Add import after the existing route imports (after `import toolApprovalRoutes from "./routes/ToolApprovalRoutes";`):

```typescript
import searchRoutes from "./routes/SearchRoutes";
```

Add the route registration after `app.use('/api/v1/tool-approval', toolApprovalRoutes);`:

```typescript
app.use('/api/v1/search', searchRoutes);
```

- [ ] **Step 4: Restart backend and smoke-test with curl**

```bash
# Start backend
npm run dev

# Global search — should return results (or empty array) without error
curl "http://localhost:20261/api/v1/search?q=hello&scope=global"

# Missing q — should return 400
curl "http://localhost:20261/api/v1/search?q=a&scope=global"

# Missing sessionId for session scope — should return 400
curl "http://localhost:20261/api/v1/search?q=hello&scope=session"

# Session-scoped with a real sessionId from your DB
curl "http://localhost:20261/api/v1/search?q=hello&scope=session&sessionId=<real-uuid>"
```

Expected global response shape:
```json
{
  "success": true,
  "message": "Search completed",
  "results": { "messages": [...], "sessions": [...], "tasks": [...], "memories": [...] },
  "totalCount": 5
}
```

- [ ] **Step 5: Commit**

```bash
git add project/src/controllers/SearchController.ts project/src/routes/SearchRoutes.ts project/src/server.ts
git commit -m "feat(search): add SearchController, SearchRoutes, register at /api/v1/search"
```

---

## Task 5: Frontend — Types, API Helper, Server Action

**Files:**
- Create: `src/types/search.ts` (in frontend project)
- Modify: `src/utils/apis.ts`
- Create: `src/actions/search.actions.ts`

All paths below are relative to `/Volumes/padmanabhadas/Chayan_Personal/all-next-js-projects/claude-lens/project/`.

- [ ] **Step 1: Create `src/types/search.ts`**

```typescript
export type TSearchScope = 'session' | 'project' | 'global';

export interface ISearchMessageResult {
    _type: 'message';
    messageId: string;
    snippet: string;
    role: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
    timestamp: string;
}

export interface ISearchSessionResult {
    _type: 'session';
    sessionId: string;
    snippet: string;
    title: string;
    description?: string;
    projectDir: string;
    updatedAt: string;
}

export interface ISearchTaskResult {
    _type: 'task';
    taskInternalId: string;
    snippet: string;
    subject: string;
    status: string;
    sessionId: string;
    sessionTitle: string;
    projectDir: string;
}

export interface ISearchMemoryResult {
    _type: 'memory';
    memoryId: string;
    snippet: string;
    filePath: string;
    projectDir: string;
}

export type ISearchResult =
    | ISearchMessageResult
    | ISearchSessionResult
    | ISearchTaskResult
    | ISearchMemoryResult;

export interface ISearchResults {
    messages: ISearchMessageResult[];
    sessions: ISearchSessionResult[];
    tasks: ISearchTaskResult[];
    memories: ISearchMemoryResult[];
}

export interface ISearchActionParams {
    q: string;
    scope: TSearchScope;
    sessionId?: string;
    projectDir?: string;
    limit?: number;
    skip?: number;
}

export interface ISearchActionResponse {
    success: boolean;
    results?: ISearchResults;
    totalCount?: number;
    error?: string;
}
```

- [ ] **Step 2: Add `searchApi` to `src/utils/apis.ts`**

In `src/utils/apis.ts`, add a base URL constant after the existing ones:

```typescript
/** Base URL for search endpoints */
const baseSearchApiUrl: string = `${baseApiUrl}/search`;
```

Then add to the `apis` object (before the closing `}`):

```typescript
    searchApi: (params: { q: string; scope: string; sessionId?: string; projectDir?: string; limit?: number; skip?: number }) => {
        const searchParams: URLSearchParams = new URLSearchParams();
        searchParams.set('q', params.q);
        searchParams.set('scope', params.scope);
        if (params.sessionId) searchParams.set('sessionId', params.sessionId);
        if (params.projectDir) searchParams.set('projectDir', params.projectDir);
        if (params.limit) searchParams.set('limit', String(params.limit));
        if (params.skip) searchParams.set('skip', String(params.skip));
        return `${baseSearchApiUrl}?${searchParams.toString()}`;
    },
```

- [ ] **Step 3: Create `src/actions/search.actions.ts`**

```typescript
"use server";

import {apis} from "@/utils/apis";
import {parseApiResponse, ApiResponseClass} from "@/utils/ApiResponse";
import {ISearchActionParams, ISearchActionResponse, ISearchResults} from "@/types/search";

async function search(params: ISearchActionParams): Promise<ISearchActionResponse> {
    try {
        const url: string = apis.searchApi(params);
        const response: Response = await fetch(url, {cache: 'no-store'});
        const data: ApiResponseClass = await parseApiResponse(response);

        if (!response.ok || !data.success) {
            console.error('Search action failed:', data.error);
            return {success: false, error: data.error?.message || 'Search failed'};
        }

        return {
            success: true,
            results: data.results as ISearchResults,
            totalCount: data.totalCount as number,
        };
    } catch (error: unknown) {
        console.error('Search action error:', error);
        return {success: false, error: 'Something went wrong. Please try again!'};
    }
}

export {search};
```

- [ ] **Step 4: Commit**

```bash
git add src/types/search.ts src/utils/apis.ts src/actions/search.actions.ts
git commit -m "feat(search): add frontend types, searchApi helper, search server action"
```

---

## Task 6: Frontend — useSearch Hook

**Files:**
- Create: `src/hooks/useSearch.ts`

- [ ] **Step 1: Create `src/hooks/useSearch.ts`**

```typescript
"use client";

import React from "react";
import {search} from "@/actions/search.actions";
import {ISearchActionParams, ISearchResults} from "@/types/search";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;

const EMPTY_RESULTS: ISearchResults = {messages: [], sessions: [], tasks: [], memories: []};

interface IUseSearchReturn {
    results: ISearchResults;
    totalCount: number;
    isLoading: boolean;
    error: string | null;
    query: string;
    setQuery: (q: string) => void;
    clear: () => void;
}

function useSearch(baseParams: Omit<ISearchActionParams, 'q'>): IUseSearchReturn {
    const [query, setQuery] = React.useState<string>('');
    const [results, setResults] = React.useState<ISearchResults>(EMPTY_RESULTS);
    const [totalCount, setTotalCount] = React.useState<number>(0);
    const [isLoading, setIsLoading] = React.useState<boolean>(false);
    const [error, setError] = React.useState<string | null>(null);

    const baseParamsRef = React.useRef(baseParams);
    baseParamsRef.current = baseParams;

    React.useEffect(() => {
        if (query.trim().length < MIN_QUERY_LEN) {
            setResults(EMPTY_RESULTS);
            setTotalCount(0);
            setError(null);
            return;
        }

        setIsLoading(true);
        setError(null);

        const timer = setTimeout(async () => {
            try {
                const response = await search({...baseParamsRef.current, q: query.trim()});
                if (response.success && response.results) {
                    setResults(response.results);
                    setTotalCount(response.totalCount ?? 0);
                } else {
                    setError(response.error ?? 'Search failed');
                    setResults(EMPTY_RESULTS);
                    setTotalCount(0);
                }
            } catch {
                setError('Something went wrong. Please try again!');
                setResults(EMPTY_RESULTS);
                setTotalCount(0);
            } finally {
                setIsLoading(false);
            }
        }, DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [query]);

    const clear = React.useCallback((): void => {
        setQuery('');
        setResults(EMPTY_RESULTS);
        setTotalCount(0);
        setError(null);
    }, []);

    return {results, totalCount, isLoading, error, query, setQuery, clear};
}

export {useSearch};
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useSearch.ts
git commit -m "feat(search): add useSearch hook with 300ms debounce and min-2-char guard"
```

---

## Task 7: Frontend — SearchModal Component

**Files:**
- Create: `src/components/SearchModal.tsx`

The modal receives `isOpen`, `onClose`, an initial `scope` chip, and optional `sessionId`/`projectDir` context. Internally it uses `useSearch` and renders chips + grouped results.

- [ ] **Step 1: Create `src/components/SearchModal.tsx`**

```typescript
"use client";

import React from "react";
import {useRouter} from "next/navigation";
import {HiOutlineSearch, HiOutlineX, HiOutlineChatAlt2, HiOutlineFolder, HiOutlineClipboardList, HiOutlineDocumentText} from "react-icons/hi";
import {cn} from "@/utils/cn";
import {routes} from "@/utils/routes";
import {useSearch} from "@/hooks/useSearch";
import {TSearchScope, ISearchResult, ISearchMessageResult, ISearchSessionResult, ISearchTaskResult, ISearchMemoryResult} from "@/types/search";

interface ISearchModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialScope: TSearchScope;
    sessionId?: string;
    projectDir?: string;
}

const SCOPE_CHIPS: {label: string; value: TSearchScope}[] = [
    {label: 'This Session', value: 'session'},
    {label: 'This Project', value: 'project'},
    {label: 'All', value: 'global'},
];

const TYPE_ICON: Record<string, React.ReactNode> = {
    message: <HiOutlineChatAlt2 className={'size-3.5 shrink-0'}/>,
    session: <HiOutlineFolder className={'size-3.5 shrink-0'}/>,
    task: <HiOutlineClipboardList className={'size-3.5 shrink-0'}/>,
    memory: <HiOutlineDocumentText className={'size-3.5 shrink-0'}/>,
};

const TYPE_LABEL: Record<string, string> = {
    message: 'Messages',
    session: 'Sessions',
    task: 'Tasks',
    memory: 'Memories',
};

function ResultCard({result, onClick}: {result: ISearchResult; onClick: () => void}) {
    const label = result._type === 'message'
        ? (result as ISearchMessageResult).sessionTitle
        : result._type === 'session'
            ? (result as ISearchSessionResult).projectDir
            : result._type === 'task'
                ? (result as ISearchTaskResult).sessionTitle
                : (result as ISearchMemoryResult).projectDir;

    const title = result._type === 'session'
        ? (result as ISearchSessionResult).title
        : result._type === 'task'
            ? (result as ISearchTaskResult).subject
            : null;

    return (
        <button
            onClick={onClick}
            className={'w-full text-left px-3 py-2.5 rounded-lg hover:bg-border transition-colors group flex flex-col gap-0.5'}
        >
            {title && (
                <p className={'text-xs font-medium text-text truncate'}>{title}</p>
            )}
            <p className={'text-xs text-text-muted leading-relaxed line-clamp-2'}>{result.snippet}</p>
            <div className={'flex items-center gap-1.5 mt-0.5'}>
                <span className={'text-text-muted/60'}>{TYPE_ICON[result._type]}</span>
                <span className={'text-[10px] text-text-muted/60 truncate'}>{label}</span>
            </div>
        </button>
    );
}

function SearchModal({isOpen, onClose, initialScope, sessionId, projectDir}: ISearchModalProps) {
    const router = useRouter();
    const [scope, setScope] = React.useState<TSearchScope>(initialScope);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const {results, totalCount, isLoading, error, query, setQuery, clear} = useSearch({
        scope,
        sessionId,
        projectDir,
    });

    React.useEffect(() => {
        if (isOpen) {
            setScope(initialScope);
            clear();
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen, initialScope]);

    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const handleResultClick = React.useCallback((targetSessionId: string): void => {
        router.push(routes.sessionPath(targetSessionId));
        onClose();
    }, [router, onClose]);

    const handleScopeChange = React.useCallback((newScope: TSearchScope): void => {
        setScope(newScope);
        clear();
        inputRef.current?.focus();
    }, [clear]);

    const isChipDisabled = (chipScope: TSearchScope): boolean => {
        if (chipScope === 'session' && !sessionId) return true;
        if (chipScope === 'project' && !projectDir) return true;
        return false;
    };

    const allResults: ISearchResult[] = [
        ...results.messages,
        ...results.sessions,
        ...results.tasks,
        ...results.memories,
    ];

    const grouped: Record<string, ISearchResult[]> = {};
    for (const r of allResults) {
        if (!grouped[r._type]) grouped[r._type] = [];
        grouped[r._type].push(r);
    }

    const getResultSessionId = (result: ISearchResult): string => {
        if (result._type === 'session') return (result as ISearchSessionResult).sessionId;
        return (result as ISearchMessageResult | ISearchTaskResult).sessionId;
    };

    if (!isOpen) return null;

    return (
        <div className={'fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4'}>
            {/* Overlay */}
            <div className={'absolute inset-0 bg-black/50 backdrop-blur-sm'} onClick={onClose}/>

            {/* Panel */}
            <div className={'relative w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[70vh]'}>
                {/* Search input */}
                <div className={'flex items-center gap-2 px-3 py-3 border-b border-border shrink-0'}>
                    <HiOutlineSearch className={'size-4 text-text-muted shrink-0'}/>
                    <input
                        ref={inputRef}
                        type={'text'}
                        value={query}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                        placeholder={'Search…'}
                        className={'flex-1 bg-transparent text-sm text-text placeholder:text-text-muted/60 outline-none'}
                    />
                    {query && (
                        <button onClick={clear} className={'text-text-muted hover:text-text transition-colors'}>
                            <HiOutlineX className={'size-3.5'}/>
                        </button>
                    )}
                </div>

                {/* Scope chips */}
                <div className={'flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0'}>
                    {SCOPE_CHIPS.map(({label, value}) => (
                        <button
                            key={value}
                            onClick={() => !isChipDisabled(value) && handleScopeChange(value)}
                            disabled={isChipDisabled(value)}
                            className={cn(
                                'px-2.5 py-1 rounded-full text-[11px] font-medium transition-all',
                                scope === value
                                    ? 'bg-primary text-background'
                                    : 'bg-border text-text-muted hover:bg-border/80',
                                isChipDisabled(value) && 'opacity-30 cursor-not-allowed',
                            )}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Results */}
                <div className={'flex-1 overflow-y-auto p-2'}>
                    {isLoading && (
                        <div className={'flex flex-col gap-1.5 p-2'}>
                            {[1, 2, 3].map((i) => (
                                <div key={i} className={'h-14 rounded-lg bg-border animate-pulse'}/>
                            ))}
                        </div>
                    )}

                    {!isLoading && error && (
                        <p className={'text-xs text-error px-3 py-4 text-center'}>{error}</p>
                    )}

                    {!isLoading && !error && query.trim().length >= 2 && totalCount === 0 && (
                        <p className={'text-xs text-text-muted px-3 py-8 text-center'}>
                            {`No results for "${query}"`}
                        </p>
                    )}

                    {!isLoading && !error && (['message', 'session', 'task', 'memory'] as const).map((type) => {
                        const group = grouped[type];
                        if (!group || group.length === 0) return null;
                        return (
                            <div key={type} className={'mb-3'}>
                                <p className={'text-[10px] font-semibold text-text-muted/60 uppercase tracking-wider px-3 py-1'}>
                                    {TYPE_LABEL[type]}
                                </p>
                                <div className={'flex flex-col gap-0.5'}>
                                    {group.map((result) => (
                                        <ResultCard
                                            key={result._type === 'message' ? (result as ISearchMessageResult).messageId
                                                : result._type === 'session' ? (result as ISearchSessionResult).sessionId
                                                    : result._type === 'task' ? (result as ISearchTaskResult).taskInternalId
                                                        : (result as ISearchMemoryResult).memoryId}
                                            result={result}
                                            onClick={() => handleResultClick(getResultSessionId(result))}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                {totalCount > 0 && !isLoading && (
                    <div className={'border-t border-border px-3 py-2 shrink-0'}>
                        <p className={'text-[10px] text-text-muted/60'}>{totalCount} result{totalCount !== 1 ? 's' : ''}</p>
                    </div>
                )}
            </div>
        </div>
    );
}

export {SearchModal};
```

- [ ] **Step 2: Verify the import paths compile**

Run from the frontend project root:
```bash
npx tsc --noEmit
```

Expected: no errors. Fix any type mismatches before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchModal.tsx
git commit -m "feat(search): add SearchModal with chips, grouped results, empty/loading states"
```

---

## Task 8: Frontend — Wire Search Buttons

**Files:**
- Modify: `src/components/layouts/AppLayout.tsx`
- Modify: `src/components/SidebarClient.tsx`
- Modify: `src/components/ChatSessionView.tsx`

All paths relative to `/Volumes/padmanabhadas/Chayan_Personal/all-next-js-projects/claude-lens/project/`.

### AppLayout.tsx — Global Search Button

- [ ] **Step 1: Add import for `HiOutlineSearch` and `SearchModal` to `AppLayout.tsx`**

The file already imports from `react-icons/hi`. Add `HiOutlineSearch` to that import:

```typescript
import {HiOutlineCog, HiOutlineMenuAlt2, HiOutlineSearch, HiOutlineTemplate, HiOutlineX} from "react-icons/hi";
```

Add import for `SearchModal` after the `ThemeSwitcher` import:

```typescript
import {SearchModal} from "@/components/SearchModal";
```

- [ ] **Step 2: Add modal state to `AppLayout` function body**

Add after `const [isCollapsed, setIsCollapsed] = React.useState<boolean>(false);`:

```typescript
const [isSearchOpen, setIsSearchOpen] = React.useState<boolean>(false);
```

- [ ] **Step 3: Add search button to header toolbar**

In the `{/* Toolbar */}` div (around line 202), add the search button as the first item:

```typescript
<Button variant={'ghost'} size={'icon'} onClick={() => setIsSearchOpen(true)} className={'size-8 text-text-muted'} title={'Search'}>
    <HiOutlineSearch className={'size-4'}/>
</Button>
```

Add it before `<SyncButton/>`.

- [ ] **Step 4: Render `SearchModal` at the bottom of the return (before closing `</div>`)**

Add before the final closing `</div>` of the component's return:

```typescript
<SearchModal
    isOpen={isSearchOpen}
    onClose={() => setIsSearchOpen(false)}
    initialScope={'global'}
/>
```

### SidebarClient.tsx — Per-Project Search Button

- [ ] **Step 5: Add `HiOutlineSearch` to `SidebarClient.tsx` imports**

The file already imports from `react-icons/hi`. Add `HiOutlineSearch`:

```typescript
import {HiOutlineChatAlt2, HiOutlineChevronRight, HiOutlineClipboardList, HiOutlineDocumentText, HiOutlineFolder, HiOutlinePlus, HiOutlineRefresh, HiOutlineSearch} from "react-icons/hi";
```

Add import for `SearchModal`:

```typescript
import {SearchModal} from "@/components/SearchModal";
```

- [ ] **Step 6: Add search state to `SidebarClient` function body**

Add after the existing state declarations:

```typescript
const [searchProjectDir, setSearchProjectDir] = React.useState<string | null>(null);
```

- [ ] **Step 7: Add search button to the project header row**

Find the project header div (around line 456):
```typescript
<div className={'shrink-0 flex items-center pr-1'}>
    <ExportProjectButton projectDir={projectDir}/>
    <DeleteProjectButton projectDir={projectDir} projectName={projectName} r2Configured={r2Configured}/>
</div>
```

Add the search button as the first item inside that div:
```typescript
<Button
    variant={'ghost'}
    size={'sm'}
    onClick={(e: React.MouseEvent) => { e.stopPropagation(); setSearchProjectDir(projectDir); }}
    className={'p-1.5 text-text-muted'}
    title={`Search in ${projectName}`}
>
    <HiOutlineSearch className={'size-3.5'}/>
</Button>
```

- [ ] **Step 8: Render `SearchModal` at the bottom of `SidebarClient`'s return**

In the main `return (...)` block (the one that renders the full sidebar), add before the closing `</nav>`:

```typescript
<SearchModal
    isOpen={searchProjectDir !== null}
    onClose={() => setSearchProjectDir(null)}
    initialScope={'project'}
    projectDir={searchProjectDir ?? undefined}
/>
```

### ChatSessionView.tsx — Session Search Button

- [ ] **Step 9: Add `HiOutlineSearch` to `ChatSessionView.tsx` imports**

Find the existing `react-icons/hi` import and add `HiOutlineSearch` to it.

Add import for `SearchModal`:

```typescript
import {SearchModal} from "@/components/SearchModal";
```

- [ ] **Step 10: Add search state to `ChatSessionView` function body**

Add after `const [isRenameModalOpen, setIsRenameModalOpen] = React.useState<boolean>(false);`:

```typescript
const [isSearchOpen, setIsSearchOpen] = React.useState<boolean>(false);
```

- [ ] **Step 11: Add search button to session toolbar**

Find the session toolbar buttons div (around line 754):
```typescript
<div className={'flex items-center gap-1 sm:gap-2 shrink-0'}>
    <Button variant={'ghost'} size={'icon'} onClick={() => handleSend('/compact')} ...
```

Add the search button as the first item:
```typescript
<Button variant={'ghost'} size={'icon'} onClick={() => setIsSearchOpen(true)} className={'size-7 text-text-muted'} title={'Search in this session'}>
    <HiOutlineSearch className={'size-3.5'}/>
</Button>
```

- [ ] **Step 12: Render `SearchModal` inside the session view**

Add after the existing `<RenameSessionModal .../>` block (around line 778):

```typescript
{localSession && (
    <SearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        initialScope={'session'}
        sessionId={localSession.sessionId}
        projectDir={localSession.projectDir}
    />
)}
```

- [ ] **Step 13: Run TypeScript check and start the dev server**

```bash
# TypeScript check
npx tsc --noEmit

# Start dev server
npm run dev
```

Verify in browser:
1. Click header search icon → modal opens with "All" chip active, "This Session" + "This Project" disabled
2. Click project search icon in sidebar → modal opens with "This Project" chip active
3. Open a session → click session toolbar search icon → modal opens with "This Session" chip active
4. Type 1 char → no request fires
5. Type 2+ chars → results appear after 300ms
6. Click a result → navigates to the session, modal closes

- [ ] **Step 14: Commit**

```bash
git add src/components/layouts/AppLayout.tsx src/components/SidebarClient.tsx src/components/ChatSessionView.tsx
git commit -m "feat(search): wire SearchModal into AppLayout, SidebarClient, and ChatSessionView"
```

---

## Self-Review

**Spec coverage check:**

| Requirement                                                    | Task                                                                                        |
|----------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Search within session (messages + tasks)                       | Tasks 1–4 (SearchService `_searchSession`), Task 7 (modal), Task 8 (ChatSessionView button) |
| Search within project (messages + sessions + tasks + memories) | Tasks 1–4 (SearchService `_searchProject`), Task 7, Task 8 (SidebarClient button)           |
| Global search (all content)                                    | Tasks 1–4 (SearchService `_searchGlobal`), Task 7, Task 8 (AppLayout button)                |
| MongoDB `$text` indexes                                        | Task 2                                                                                      |
| Single-select scope chips                                      | Task 7 (SearchModal chips)                                                                  |
| Debounced 300ms                                                | Task 6 (useSearch)                                                                          |
| Min 2 chars before querying                                    | Task 6 (useSearch), Task 4 (controller validation)                                          |
| Navigate on result click                                       | Task 7 (ResultCard onClick)                                                                 |
| Disabled chip when context unavailable                         | Task 7 (`isChipDisabled`)                                                                   |
| Empty state                                                    | Task 7                                                                                      |
| Loading skeleton                                               | Task 7                                                                                      |
| No shortcuts (IconButton only)                                 | Task 8 — no keyboard shortcuts added                                                        |

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N". All code blocks are complete. All file paths are exact.

**Type consistency:**
- `ISearchResults` defined in Task 1 (backend) and Task 5 (frontend) with matching shapes
- `extractTextFromContent` in Task 3 uses `TextBlock` and `ThinkingBlock` imported from `../models/Message` — exported there (line 29 of Message.ts)
- `useSearch` in Task 6 takes `Omit<ISearchActionParams, 'q'>` — `ISearchActionParams` defined in Task 5
- `SearchModal` in Task 7 uses `useSearch` from Task 6, `ISearchResult` union from Task 5
- `getResultSessionId` in Task 7: `memory` results don't have `sessionId` — they only have `projectDir`. Memory results should open the project's first session or be excluded from navigation. **Fix:** add a guard — if `result._type === 'memory'`, skip `router.push` and show a toast or just close. For now, memory results won't navigate (they don't have a sessionId). Update `getResultSessionId`:

```typescript
const getResultSessionId = (result: ISearchResult): string | null => {
    if (result._type === 'memory') return null;
    if (result._type === 'session') return (result as ISearchSessionResult).sessionId;
    return (result as ISearchMessageResult | ISearchTaskResult).sessionId;
};
```

And in `ResultCard onClick`:
```typescript
onClick={() => {
    const targetSessionId = getResultSessionId(result);
    if (targetSessionId) handleResultClick(targetSessionId);
}}
```

Update Task 7 Step 1 to use the above corrected version of both `getResultSessionId` and the `onClick`.
