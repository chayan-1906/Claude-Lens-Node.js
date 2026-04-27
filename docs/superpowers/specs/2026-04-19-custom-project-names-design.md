# Custom Project Names — Design Spec
_Date: 2026-04-19_

## Problem

Projects in Claude Lens are identified by filesystem paths. The sidebar derives display names using a VS Code-style disambiguation algorithm (e.g. `NodeJs/claude-lens`). There is no way for the user to assign a human-friendly name to a project.

## Goal

Allow users to set a custom display name per project, stored in MongoDB, surfaced in the sidebar in place of the path-derived name.

---

## Data Model

### New `Project` Mongoose Schema (`project/src/models/Project.ts`)

```typescript
{
  rawProjectDir: string;   // full absolute path — unique index
  projectDir:    string;   // hashed identifier — unique index
  customName?:   string;   // user-defined display name
  description?:  string;   // optional project description
  lastSessionAt: Date;     // refreshed on every session upsert
  orphanedAt?:   Date;     // set when last session is deleted; TTL index 7 days
}
```

**TTL index:** `orphanedAt` with `expireAfterSeconds: 604800` (7 days).
- Set to `now` when the deleted session is the **last** session for that `projectDir`.
- Cleared (`$unset`) when a new session is upserted for that `projectDir`.
- This means orphan `Project` docs (no sessions) auto-expire after 7 days.
- Explicitly deleted when the project is deleted via `DELETE /api/v1/projects/:projectDir`.

---

## Backend Changes

### 1. New `Project` model
`project/src/models/Project.ts` — Mongoose schema as above.

### 2. Upsert in `WebSocketHandler.ts`
On session start (system event upsert), also upsert the `Project` doc:
```
Project.updateOne(
  { projectDir },
  { $set: { rawProjectDir, lastSessionAt: now }, $unset: { orphanedAt: '' } },
  { upsert: true }
)
```

### 3. Update `getAllProjects` (`ProjectService.ts`)
Add `$lookup` against the `Project` collection to enrich each result with `customName` and `description`.

Updated `IProject`:
```typescript
interface IProject {
  rawProjectDir: string;
  projectDir:    string;
  customName?:   string;
  description?:  string;
}
```

### 4. New `PATCH /api/v1/projects/:projectDir` endpoint
- Controller: `renameProjectController`
- Body: `{ customName: string; description?: string }`
- Validates `customName` is non-empty string, max 100 chars
- Updates `Project` doc, returns updated `IProject`

### 5. Update `deleteProject` controller
Add `Project.deleteOne({ projectDir })` inside the existing MongoDB transaction.

### 6. Update `deleteSession` controller
After deleting the session:
```
const remaining = await Session.countDocuments({ projectDir });
if (remaining === 0) {
  await Project.updateOne({ projectDir }, { $set: { orphanedAt: new Date() } });
}
```

---

## Frontend Changes

### 1. Update `IProject` type (`src/types/project.ts`)
Add `customName?: string` and `description?: string`.

### 2. `SidebarClient.tsx` — display logic
In `computeProjectDisplayNames()`: if `project.customName` is set, use it directly and exclude the project from the path-disambiguation algorithm (it has no conflicts to resolve).

### 3. Tooltip on expand button
The collapsible `>` toggle button gets a `title={project.rawProjectDir}` tooltip showing the full path on hover.

### 4. Replace per-row icons with three-dot context menu
Remove the individual download and delete icon buttons from project rows.
Add a `⋮` (vertical ellipsis) button visible on row hover.
Context menu items:
- **Export** (existing download action)
- **Rename** (opens `RenameProjectModal`)
- **Delete** (existing delete action with confirmation)

### 5. New `RenameProjectModal` component
Mirrors the existing `RenameSessionModal` pattern:
- Title: "Rename Project"
- Field: "Project Name" — pre-filled with `customName ?? computedDisplayName`, max 100 chars, char counter
- Field: "Description (optional)" — pre-filled with `description`, max 500 chars
- Buttons: Cancel / Save

### 6. New server action `renameProject`
`src/actions/project.actions.ts`:
```typescript
renameProject(projectDir: string, customName: string, description?: string)
```
Calls `PATCH /api/v1/projects/:projectDir`, then `revalidateTag('projects')`.

---

## UX Behaviour

| State               | Sidebar displays                                    |
|---------------------|-----------------------------------------------------|
| No custom name      | Path-based disambiguation (current behaviour)       |
| Custom name set     | `customName` (path logic bypassed for this project) |
| Hover on `>` button | Tooltip: full `rawProjectDir`                       |

---

## Out of Scope

- Bulk rename
- Project-level color or icon
- Search/filter by custom name
