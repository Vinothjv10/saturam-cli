# Project Onboarding Integrations Overview

This document summarizes the onboarding integrations, sample responses, normalization logic, configuration, and commands available in the CLI.

---

## 1. Active Integration Services

Each integration service wraps target REST APIs and handles authorization internally.

### Confluence ([confluence.service.ts](file:///root/saturam/saturam-cli/src/integrations/confluence/services/confluence.service.ts))
* **`getPage(baseUrl, pageId)`**
  * *Sample Response:* `{ id: "12345", title: "Page Name", body: { storage: { value: "<p>HTML...</p>" } }, version: { number: 1 }, space: { key: "DS" } }`
* **`getPageMetadata(baseUrl, pageId)`**
  * *Sample Response:* `{ id: "12345", title: "Page Name", version: { number: 1 }, space: { key: "DS" } }`
* **`listChildPages(baseUrl, pageId)`**
  * *Sample Response:* `{ results: [{ id: "67890", title: "Child Page Title", type: "page" }] }`
* **`listSpaces(baseUrl)`**
  * *Sample Response:* `{ results: [{ id: 111, key: "DS", name: "Data Science Space", type: "global" }] }`
* **`listPagesInSpace(baseUrl, spaceKey)`**
  * *Sample Response:* `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`
* **`searchContent(baseUrl, cql)`**
  * *Sample Response:* `{ results: [{ id: "12345", title: "Page Name", type: "page" }] }`

### Jira ([jira.service.ts](file:///root/saturam/saturam-cli/src/integrations/jira/services/jira.service.ts))
* **`getIssue(baseUrl, issueKey)`**
  * *Sample Response:* `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" }, description: { type: "doc", content: [...] }, comment: { comments: [...] } } }`
* **`getIssueMetadata(baseUrl, issueKey)`**
  * *Sample Response:* `{ id: "1000", key: "DS-1", fields: { summary: "Issue summary", status: { name: "To Do" } } }`
* **`searchIssues(baseUrl, jql)`**
  * *Sample Response:* `{ issues: [{ id: "1000", key: "DS-1", fields: { ... } }] }`
* **`searchIssueKeys(baseUrl, jql)`**
  * *Sample Response:* `["DS-1", "DS-2"]`
* **`listProjects(baseUrl)`**
  * *Sample Response:* `[{ id: "10010", key: "DS", name: "Data Science" }]`
* **`listBoards(baseUrl)`**
  * *Sample Response:* `{ values: [{ id: 1, name: "DS Board", type: "scrum" }] }`
* **`getBoardBacklogIssues(baseUrl, boardId)`**
  * *Sample Response:* `{ issues: [{ key: "DS-5", fields: { summary: "Backlog ticket" } }] }`
* **`listChildIssues(baseUrl, parentKey)`**
  * *Sample Response:* `{ issues: [{ key: "DS-10", fields: { summary: "Child subtask" } }] }`

### Google Drive ([google-drive.service.ts](file:///root/saturam/saturam-cli/src/integrations/google-drive/services/google-drive.service.ts))
* **`getFileMetadata(fileId)`**
  * *Sample Response:* `{ id: "file-id", name: "Doc Name", mimeType: "application/vnd.google-apps.document", owners: [...] }`
* **`getFileBinary(fileId)`**
  * *Sample Response:* `ArrayBuffer` (Raw file bytes representation)
* **`listFilesInFolder(folderId)`**
  * *Sample Response:* `{ files: [{ id: "file-id", name: "File Name", mimeType: "text/plain" }] }`
* **`searchFiles(query)`**
  * *Sample Response:* `{ files: [{ id: "file-id", name: "Matched File" }] }`
* **`getGoogleDoc(documentId)`**
  * *Sample Response:* `{ documentId: "doc-id", title: "Document Title", body: { content: [...] } }`
* **`exportGoogleDocAsMarkdown(documentId)`**
  * *Sample Response:* `"Raw markdown text formatted string"`
* **`exportGoogleDocAsHtml(documentId)`**
  * *Sample Response:* `"Raw HTML string representation of the document"`
* **`getSpreadsheetMetadata(spreadsheetId)`**
  * *Sample Response:* `{ spreadsheetId: "sheet-id", properties: { title: "Title" }, sheets: [{ properties: { title: "Sheet1" } }] }`
* **`getSpreadsheetData(spreadsheetId)`**
  * *Sample Response:* `{ spreadsheetId: "sheet-id", valueRanges: [{ range: "Sheet1!A1:Z100", values: [["header1", "header2"], ["val1", "val2"]] }] }`
* **`batchGetSpreadsheetValues(spreadsheetId, ranges)`**
  * *Sample Response:* `{ valueRanges: [{ range: "Sheet1!A:E", values: [["header1"], ["row1"]] }] }`

---

## 2. Reusable Knowledge Adapters & Normalization Pipelines

Raw payloads are converted into standard Markdown or structured JSON via adapters implementing the `KnowledgeSource` model:

### Knowledge Source Adapters ([src/services/knowledge/](file:///root/saturam/saturam-cli/src/services/knowledge/))
* **`ConfluenceKnowledgeSource`**: Syncs Confluence page storage format into Markdown using HTML normalizers.
* **`JiraKnowledgeSource`**: Syncs Jira issues and their comments into Markdown using ADF normalizers.
* **`GoogleDriveKnowledgeSource`**: Syncs Google Docs and Drive binary files into Markdown/raw formats.

### Normalizer Services ([src/services/normalizers/](file:///root/saturam/saturam-cli/src/services/normalizers/))
* **ADF to Markdown ([adf-normalizer.service.ts](file:///root/saturam/saturam-cli/src/services/normalizers/adf-normalizer.service.ts))**: Converts Jira JSON-based Atlassian Document Format (ADF) nodes recursively into clean Markdown text (bold, lists, blockquotes, mentions, etc.).
* **HTML/XHTML to Markdown ([html-normalizer.service.ts](file:///root/saturam/saturam-cli/src/services/normalizers/html-normalizer.service.ts))**: Parses Confluence storage XHTML and Mammoth HTML strings into clean Markdown blocks, standardizing headers, bullet points, user references, and tables.
* **Google Sheets to JSON**: Fetches rows and cells and saves them as a structured, queryable JSON sidecar list.
* **Word Documents (.docx)**: Downloads raw access bytes, extracts HTML locally via `mammoth.js`, and normalizes it into Markdown via `HtmlNormalizerService`.

---

## 3. Orchestration & Configuration

### Orchestrator ([onboard.service.ts](file:///root/saturam/saturam-cli/src/services/onboarding/onboard.service.ts))
The orchestrator reads project configuration lists, triggers parallel fetch requests, resolves URLs found in Google Sheets, and routes tasks to the appropriate knowledge adapters.

### Google Sheets URL Resolution & Project Tab Mapping
When syncing via Google Sheets, the orchestrator:
1. **Scans Cells for Document Links**: Cells are recursively searched for Confluence pages, Jira tickets, Google Docs, and nested Google Sheets.
2. **Dynamic Tab Discovery**: If `range` is omitted in the configuration, all sheet tabs are automatically discovered and processed in an optimized batch network call.
3. **Tab-to-Project name mapping**: Tab titles (e.g. `ProjectA`, `ProjectB`) are treated as project folder names, syncing their resolved documents under corresponding directories (e.g. `onboarding/confluence/projecta/...`).
4. **Nested Sheets Sync**: Extracted Google Sheet links inside spreadsheet cells are processed recursively as sub-sheet tasks, saving their raw data as JSON sidecar structures.

### Personal Configuration (`config.json`)
The CLI stores user-level integration credentials (API tokens and Google OAuth tokens) inside a single personal config file at `~/.config/sateng/config.json`. These credentials can be configured using `sat-cli init` or overridden using environment variables.

---

## 4. Run Commands

### Initialize Setup
Setup your integration credentials interactively:
```bash
npx ts-node src/entrypoints/main.ts init
```
This lets you configure AI providers, SCM platforms, Atlassian integrations, and Google Drive integrations at the top level.

### Sync Onboarding Content (Dual-Mode)

#### Mode A: Sync from Local Configuration
Fetch and synchronize documents based on the `.sateng/onboarding.json` targets:
```bash
npx ts-node src/entrypoints/main.ts onboard
```

#### Mode B: Sync Directly from a Google Sheet
Fetch and synchronize documents directly from a Google Sheet URL or spreadsheet ID without needing local config files:
```bash
npx ts-node src/entrypoints/main.ts onboard <spreadsheet_url_or_id>
```
