import { OnboardService, SyncedDocument } from "../../../src/services/onboarding/onboard.service";
import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../../../src/services/config-service";
import { S3Service } from "../../../src/integrations/aws/services/s3.service";
import { JiraKnowledgeSource } from "../../../src/services/knowledge/jira-knowledge.source";
import { ConfluenceKnowledgeSource } from "../../../src/services/knowledge/confluence-knowledge.source";
import { GoogleDriveKnowledgeSource } from "../../../src/services/knowledge/google-drive-knowledge.source";
import { KnowledgeDocument, KnowledgeSourceType } from "../../../src/services/knowledge/knowledge-source.model";
import { GoogleSheetsKnowledgeSource } from "../../../src/services/knowledge/google-sheets-knowledge.source";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";

jest.mock("fs/promises", () => ({
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    readFile: jest.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
}));

// Helpers to build minimal KnowledgeDocuments in tests
const makeDoc = (overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
    id: "test-id",
    source: KnowledgeSourceType.JIRA,
    title: "Test Doc",
    content: "# Test Doc\n",
    url: "https://example.com/browse/TEST-1",
    metadata: { updatedAt: "2026-07-01", author: "Alice", labels: [] },
    ...overrides,
});

describe("OnboardService", () => {
    let service: OnboardService;
    let mockConfluence: jest.Mocked<ConfluenceService>;
    let mockJira: jest.Mocked<JiraService>;
    let mockGoogleDrive: jest.Mocked<GoogleDriveService>;
    let mockConfig: jest.Mocked<ConfigService>;
    let mockJiraSource: jest.Mocked<JiraKnowledgeSource>;
    let mockConfluenceSource: jest.Mocked<ConfluenceKnowledgeSource>;
    let mockGoogleDriveSource: jest.Mocked<GoogleDriveKnowledgeSource>;
    let mockGoogleSheetsSource: jest.Mocked<GoogleSheetsKnowledgeSource>;
    let mockS3: jest.Mocked<S3Service>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockConfluence = {
            getPage: jest.fn(),
            getPageMetadata: jest.fn(),
            listChildPages: jest.fn(),
            listSpaces: jest.fn(),
            listPagesInSpace: jest.fn(),
            listAllPagesInSpace: jest.fn(),
            searchContent: jest.fn(),
        } as any;

        mockJira = {
            getIssue: jest.fn(),
            getIssueMetadata: jest.fn(),
            searchIssueKeys: jest.fn(),
            searchIssues: jest.fn(),
            listAllIssuesByJql: jest.fn(),
            listChildIssues: jest.fn(),
            listProjects: jest.fn(),
            listBoards: jest.fn(),
            getBoardBacklogIssues: jest.fn(),
        } as any;

        mockGoogleDrive = {
            getFileMetadata: jest.fn(),
            getGoogleDoc: jest.fn(),
            exportGoogleDocAsMarkdown: jest.fn(),
            exportGoogleDocAsHtml: jest.fn(),
            getFileBinary: jest.fn(),
            listFilesInFolder: jest.fn(),
            searchFiles: jest.fn(),
            getSpreadsheetData: jest.fn(),
            getSpreadsheetMetadata: jest.fn(),
            batchGetSpreadsheetValues: jest.fn(),
        } as any;

        mockConfig = {
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;

        // Adapter mocks — these are what OnboardService now calls for fetch+normalize
        mockJiraSource = { fetch: jest.fn() } as any;
        mockConfluenceSource = { fetch: jest.fn() } as any;
        mockGoogleDriveSource = { fetch: jest.fn() } as any;
        mockGoogleSheetsSource = {
            fetch: jest.fn().mockImplementation(async (id: string, options?: any) => ({
                id,
                source: KnowledgeSourceType.GOOGLE_SHEETS,
                title: id === "sheet-id-abc" ? "Spreadsheet Title" : "Nested Sheet",
                content: "# Title\n",
                url: `https://docs.google.com/spreadsheets/d/${id}`,
                metadata: { updatedAt: "2026-07-01" },
                sheetRows: [["header1"], ["row1"]],
                sheetRange: options?.range ?? "Sheet1",
            })),
        } as any;

        mockS3 = {
            getObject: jest.fn(),
            putObject: jest.fn().mockResolvedValue(undefined),
            listObjects: jest.fn().mockResolvedValue([]),
            objectExists: jest.fn().mockResolvedValue(false),
        } as any;

        service = new OnboardService(
            mockConfluence,
            mockJira,
            mockGoogleDrive,
            mockJiraSource,
            mockConfluenceSource,
            mockGoogleDriveSource,
            mockGoogleSheetsSource,
            mockConfig,
            mockS3,
        );
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("projectNameOverride", () => {
        it("uses the auto-derived project name when no override is passed", async () => {
            const config = {
                projects: {
                    MyProject: {
                        confluence: { baseUrl: "https://confluence.example.com", pages: ["123"] },
                    },
                },
            };

            const doc = makeDoc({
                id: "123",
                source: KnowledgeSourceType.CONFLUENCE,
                title: "Test Confluence Page",
            });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            const writeCall = (writeFile as jest.Mock).mock.calls.find((call) => String(call[0]).endsWith(".md"));
            expect(writeCall[0]).toContain("/myproject/");
        });

        it("syncs only the matching project's tasks (case/punctuation-insensitive) and writes them under it", async () => {
            const config = {
                confluence: { baseUrl: "https://confluence.example.com", pages: ["global-page"] },
                projects: {
                    "My Project": {
                        confluence: { baseUrl: "https://confluence.example.com", pages: ["123"] },
                    },
                    OtherProject: {
                        confluence: { baseUrl: "https://confluence.example.com", pages: ["456"] },
                    },
                },
            };

            const doc = makeDoc({
                id: "123",
                source: KnowledgeSourceType.CONFLUENCE,
                title: "Test Confluence Page",
            });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd", "MY-PROJECT");

            expect(mockConfluenceSource.fetch).toHaveBeenCalledTimes(1);
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("123", {
                baseUrl: "https://confluence.example.com",
            });

            const writeCall = (writeFile as jest.Mock).mock.calls.find((call) => String(call[0]).endsWith(".md"));
            expect(writeCall[0]).toContain("/my-project/");
        });

        it("syncs nothing and warns when the override matches no project in the config", async () => {
            const config = {
                projects: {
                    MyProject: {
                        confluence: { baseUrl: "https://confluence.example.com", pages: ["123"] },
                    },
                },
            };

            const result = await service.sync(config, "/mock/cwd", "NoSuchProject");

            expect(mockConfluenceSource.fetch).not.toHaveBeenCalled();
            expect(result.filesWritten).toHaveLength(0);
        });

        it("excludes global (non-project) config entries when filtering to a project", async () => {
            const config = {
                confluence: { baseUrl: "https://confluence.example.com", pages: ["global-page"] },
                jira: { baseUrl: "https://jira.example.com", tickets: ["GLOBAL-1"] },
                googleDocs: { docs: ["global-doc"] },
                projects: {
                    MyProject: {
                        confluence: { baseUrl: "https://confluence.example.com", pages: ["123"] },
                    },
                },
            };

            const doc = makeDoc({
                id: "123",
                source: KnowledgeSourceType.CONFLUENCE,
                title: "Test Confluence Page",
            });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd", "MyProject");

            expect(mockConfluenceSource.fetch).toHaveBeenCalledTimes(1);
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("123", expect.any(Object));
            expect(mockJiraSource.fetch).not.toHaveBeenCalled();
            expect(mockGoogleDriveSource.fetch).not.toHaveBeenCalled();
        });

        it("does not cross-contaminate project filtering between two concurrent sync() calls on the same singleton instance", async () => {
            const configFor = (baseUrl: string) => ({
                projects: {
                    Alpha: { confluence: { baseUrl, pages: ["a-page"] } },
                    Beta: { confluence: { baseUrl, pages: ["b-page"] } },
                },
            });

            // Both fetches resolve only after both sync() calls have started, so their
            // projectNameOverride would collide if it were shared instance state instead of
            // being threaded per-call.
            let resolveA!: () => void;
            let resolveB!: () => void;
            const aStarted = new Promise<void>((resolve) => (resolveA = resolve));
            const bStarted = new Promise<void>((resolve) => (resolveB = resolve));

            mockConfluenceSource.fetch.mockImplementation(async (id: string) => {
                if (id === "a-page") {
                    resolveA();
                    await bStarted;
                } else {
                    resolveB();
                    await aStarted;
                }
                return makeDoc({ id, source: KnowledgeSourceType.CONFLUENCE, title: `Page ${id}` });
            });

            const [resultA, resultB] = await Promise.all([
                service.sync(configFor("https://a.example.com"), "/mock/cwd", "Alpha"),
                service.sync(configFor("https://b.example.com"), "/mock/cwd", "Beta"),
            ]);

            expect(resultA.filesWritten).toHaveLength(1);
            expect(resultB.filesWritten).toHaveLength(1);

            const paths = (writeFile as jest.Mock).mock.calls
                .map((call) => String(call[0]))
                .filter((p) => p.endsWith(".md"));
            expect(paths.some((p) => p.includes("/alpha/"))).toBe(true);
            expect(paths.some((p) => p.includes("/beta/"))).toBe(true);
        });
    });

    describe("sync Confluence pages", () => {
        it("should call confluenceSource.fetch and persist docs", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    pages: ["123"],
                },
            };

            const doc = makeDoc({
                id: "123",
                source: KnowledgeSourceType.CONFLUENCE,
                title: "Test Confluence Page",
                content: "# Test Confluence Page\n",
                url: "https://confluence.example.com/wiki/spaces/TST/pages/123",
            });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            const result = await service.sync(config, "/mock/cwd");

            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("123", {
                baseUrl: "https://confluence.example.com",
            });
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();

            // sync() returns Bedrock-ready metadataAttributes alongside each content file's path
            expect(result.filesWritten).toHaveLength(1);
            expect(result.filesWritten[0].contentPath).toMatch(/\.md$/);
            expect(result.filesWritten[0].metadataAttributes).toEqual({
                title: "Test Confluence Page",
                source: KnowledgeSourceType.CONFLUENCE,
                url: "https://confluence.example.com/wiki/spaces/TST/pages/123",
                category: "confluence",
                updatedAt: "2026-07-01",
                author: "Alice",
            });
        });

        it("preserves a title's trailing digits when resolving an output-path collision instead of stripping them", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    pages: [
                        { id: "111", outputPath: "docs/release-2026.md" },
                        { id: "222", outputPath: "docs/release-2026.md" },
                    ],
                },
            };

            mockConfluenceSource.fetch.mockImplementation(async (id: string) =>
                makeDoc({ id, source: KnowledgeSourceType.CONFLUENCE, title: "Release 2026" }),
            );

            const result = await service.sync(config, "/mock/cwd");

            const paths = result.filesWritten.map((f) => f.contentPath);
            // The second page's colliding outputPath must be renamed by appending a fresh "-2"
            // suffix, not by corrupting the "2026" that the base name already ends in.
            expect(paths).toContain("/mock/cwd/docs/release-2026.md");
            expect(paths.some((p) => p.endsWith("release-2026-2.md"))).toBe(true);
            expect(paths.some((p) => p.endsWith("release-2.md"))).toBe(false);
        });

        it("should use listAllPagesInSpace to resolve space pages (no inline while loop)", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    spaces: ["TST"],
                },
            };

            const pages = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}` }));
            mockConfluence.listAllPagesInSpace.mockResolvedValue(pages as any);

            const doc = makeDoc({ source: KnowledgeSourceType.CONFLUENCE, title: "Mocked Page" });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            // Should delegate pagination to the service helper, not call listPagesInSpace directly
            expect(mockConfluence.listAllPagesInSpace).toHaveBeenCalledWith("https://confluence.example.com", "TST");
            expect(mockConfluenceSource.fetch).toHaveBeenCalledTimes(5);
        });

        it("skips global confluence.spaces entirely when filtering to a project, even if the space key happens to match", async () => {
            const config = {
                confluence: {
                    baseUrl: "https://confluence.example.com",
                    spaces: ["TST"],
                },
            };

            const pages = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}` }));
            mockConfluence.listAllPagesInSpace.mockResolvedValue(pages as any);

            // A --project-name that happens to equal the space key must not accidentally pull
            // this global space in — global entries are excluded entirely under a project filter.
            await service.sync(config, "/mock/cwd", "TST");

            expect(mockConfluence.listAllPagesInSpace).not.toHaveBeenCalled();
        });

        it("should use listAllPagesInSpace for project-level space config", async () => {
            const config = {
                projects: {
                    "my-project": {
                        confluence: {
                            baseUrl: "https://confluence.example.com",
                            space: "PROJ",
                        },
                    },
                },
            };

            mockConfluence.listAllPagesInSpace.mockResolvedValue([{ id: "page-1" }] as any);
            const doc = makeDoc({ source: KnowledgeSourceType.CONFLUENCE, title: "Project Page" });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            expect(mockConfluence.listAllPagesInSpace).toHaveBeenCalledWith("https://confluence.example.com", "PROJ");
            expect(mockConfluenceSource.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe("sync Jira tickets", () => {
        it("should call jiraSource.fetch and persist docs", async () => {
            const config = {
                jira: {
                    baseUrl: "https://jira.example.com",
                    tickets: ["TST-101"],
                },
            };

            const doc = makeDoc({
                id: "TST-101",
                source: KnowledgeSourceType.JIRA,
                title: "Jira Ticket Summary",
                url: "https://jira.example.com/browse/TST-101",
            });
            mockJiraSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            expect(mockJiraSource.fetch).toHaveBeenCalledWith("TST-101", { baseUrl: "https://jira.example.com" });
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });

        it("should use listAllIssuesByJql to resolve JQL tickets (no inline while loop)", async () => {
            const config = {
                projects: {
                    "my-project": {
                        jira: {
                            baseUrl: "https://jira.example.com",
                            jql: "project = TST",
                        },
                    },
                },
            };

            const keys = ["TST-0", "TST-1", "TST-2"];
            mockJira.listAllIssuesByJql.mockResolvedValue(keys);

            const doc = makeDoc({ source: KnowledgeSourceType.JIRA, title: "Jira Ticket" });
            mockJiraSource.fetch.mockResolvedValue(doc);

            await service.sync(config as any, "/mock/cwd");

            // Should delegate pagination to the service helper, not call searchIssues directly
            expect(mockJira.listAllIssuesByJql).toHaveBeenCalledWith("https://jira.example.com", "project = TST");
            expect(mockJiraSource.fetch).toHaveBeenCalledTimes(3);
        });
    });

    describe("sync Google Docs", () => {
        it("should call googleDriveSource.fetch and persist docs", async () => {
            const config = {
                googleDocs: {
                    docs: ["doc-id-xyz"],
                },
            };

            const doc = makeDoc({
                id: "doc-id-xyz",
                source: KnowledgeSourceType.GOOGLE_DOCS,
                title: "Google Doc Title",
                content: "# Document Content\n",
                url: "https://docs.google.com/document/d/doc-id-xyz/edit",
            });
            mockGoogleDriveSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDriveSource.fetch).toHaveBeenCalledWith("doc-id-xyz");
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });
    });

    describe("sync Google Sheets", () => {
        it("should fetch cell values and save sidecar json", async () => {
            const config = {
                googleSheets: {
                    spreadsheetId: "sheet-id-abc",
                    range: "Sheet1!A:E",
                },
            };
            await service.sync(config, "/mock/cwd");

            expect(mockGoogleSheetsSource.fetch).toHaveBeenCalledWith("sheet-id-abc", { range: "Sheet1!A:E" });
            expect(mkdir).toHaveBeenCalled();
            // Writes both the Markdown (uploaded/ingested content) and the JSON sidecar (local only).
            expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.md$/), "# Title\n", "utf8");
            expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.json$/), expect.any(String), "utf8");
        });

        it("renames instead of overwriting when two sheets in the same run share a title", async () => {
            mockGoogleSheetsSource.fetch.mockImplementation(async (id: string) => ({
                id,
                source: KnowledgeSourceType.GOOGLE_SHEETS,
                title: "Same Title",
                content: `# ${id}\n`,
                url: `https://docs.google.com/spreadsheets/d/${id}`,
                metadata: { updatedAt: "2026-07-01" },
                sheetRows: [["header1"], ["row1"]],
                sheetRange: "Sheet1",
            }));

            const mdPaths: string[] = [];
            (writeFile as jest.Mock).mockImplementation((path: string) => {
                if (String(path).endsWith(".md")) mdPaths.push(String(path));
                return Promise.resolve();
            });

            // "My Project" and "my-project" slugify to the same directory name, and both sheets
            // resolve to "Same Title" — they must land in the same directory without one silently
            // overwriting the other's content.
            await service.sync(
                {
                    projects: {
                        "My Project": { googleSheets: { spreadsheetId: "sheet-a" } },
                        "my-project": { googleSheets: { spreadsheetId: "sheet-b" } },
                    },
                },
                "/mock/cwd",
            );

            expect(mdPaths).toHaveLength(2);
            expect(new Set(mdPaths).size).toBe(2);
        });
    });

    describe("sync onboardingSheets document link resolution", () => {
        it("should parse spreadsheet cell values for Confluence, Jira, and Google Doc links and sync them", async () => {
            const config = {
                onboardingSheets: [
                    {
                        spreadsheetId: "sheet-links-id",
                        range: "LinksSheet!A:B",
                    },
                ],
            };

            mockGoogleDrive.getSpreadsheetMetadata.mockImplementation(async (id: string) => {
                if (id === "sheet-links-id") {
                    return {
                        spreadsheetId: "sheet-links-id",
                        title: "Links Spreadsheet",
                        sheets: [{ title: "LinksSheet" }],
                    } as any;
                }
                if (id === "another-nested-sheet-id") {
                    return {
                        spreadsheetId: "another-nested-sheet-id",
                        title: "Nested Sheet",
                        sheets: [{ title: "Sheet1" }],
                    } as any;
                }
                return {} as any;
            });

            mockGoogleDrive.batchGetSpreadsheetValues.mockImplementation(async (id: string, ranges: string[]) => {
                if (id === "sheet-links-id") {
                    return {
                        valueRanges: [
                            {
                                range: "LinksSheet!A:B",
                                values: [
                                    ["Jira issue", "https://saturam.atlassian.net/browse/DB-826"],
                                    [
                                        "Confluence page",
                                        "https://saturam.atlassian.net/wiki/spaces/Alkem/pages/231145593",
                                    ],
                                    [
                                        "Google Doc",
                                        "https://docs.google.com/document/d/1FZv2bZ1KIVTGRWtK63w3oC25sr1UiPSN",
                                    ],
                                    [
                                        "Google Sheet",
                                        "https://docs.google.com/spreadsheets/d/another-nested-sheet-id/edit",
                                    ],
                                    ["Some non-link text", "some random data"],
                                ],
                            },
                        ],
                    } as any;
                }
                if (id === "another-nested-sheet-id") {
                    return {
                        valueRanges: [
                            {
                                range: "Sheet1",
                                values: [["header1"], ["val1"]],
                            },
                        ],
                    } as any;
                }
                return {} as any;
            });

            mockJiraSource.fetch.mockResolvedValue(
                makeDoc({ id: "DB-826", source: KnowledgeSourceType.JIRA, title: "DB-826 Ticket" }),
            );
            mockConfluenceSource.fetch.mockResolvedValue(
                makeDoc({ id: "231145593", source: KnowledgeSourceType.CONFLUENCE, title: "Confluence Page" }),
            );
            mockGoogleDriveSource.fetch.mockResolvedValue(
                makeDoc({
                    id: "1FZv2bZ1KIVTGRWtK63w3oC25sr1UiPSN",
                    source: KnowledgeSourceType.GOOGLE_DOCS,
                    title: "Google Doc Spec",
                }),
            );

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("sheet-links-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-links-id", [
                "LinksSheet!A:B",
            ]);

            expect(mockGoogleSheetsSource.fetch).toHaveBeenCalledWith("another-nested-sheet-id", { range: undefined });

            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("231145593", {
                baseUrl: "https://saturam.atlassian.net",
            });
            expect(mockGoogleDriveSource.fetch).toHaveBeenCalledWith("1FZv2bZ1KIVTGRWtK63w3oC25sr1UiPSN");

            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });

        it("should parse spreadsheet cell values across all tabs when range is not specified, mapping tab names to project names", async () => {
            const config = {
                onboardingSheets: [
                    {
                        spreadsheetId: "multi-tab-sheet-id",
                    },
                ],
            };

            const mockMeta = {
                spreadsheetId: "multi-tab-sheet-id",
                title: "Multi-tab Onboarding",
                sheets: [{ title: "ProjectAlpha" }, { title: "ProjectBeta" }],
            } as any;

            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        range: "ProjectAlpha!A1:Z100",
                        values: [["Jira issue A", "https://saturam.atlassian.net/browse/DB-826"]],
                    },
                    {
                        range: "ProjectBeta!A1:Z100",
                        values: [
                            ["Confluence page B", "https://saturam.atlassian.net/wiki/spaces/Alkem/pages/231145593"],
                        ],
                    },
                ],
            });

            mockJiraSource.fetch.mockResolvedValue(
                makeDoc({ id: "DB-826", source: KnowledgeSourceType.JIRA, title: "DB-826 Ticket" }),
            );
            mockConfluenceSource.fetch.mockResolvedValue(
                makeDoc({ id: "231145593", source: KnowledgeSourceType.CONFLUENCE, title: "Confluence Page" }),
            );

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("multi-tab-sheet-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("multi-tab-sheet-id", [
                "'ProjectAlpha'",
                "'ProjectBeta'",
            ]);

            // Verify that resolved tasks were parsed with correct projectNames (i.e. tab titles)
            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("231145593", {
                baseUrl: "https://saturam.atlassian.net",
            });

            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });

        it("filters tab-derived projects by --project-name without skipping global onboardingSheets resolution", async () => {
            const config = {
                onboardingSheets: [
                    {
                        spreadsheetId: "multi-tab-sheet-id",
                    },
                ],
            };

            const mockMeta = {
                spreadsheetId: "multi-tab-sheet-id",
                title: "Multi-tab Onboarding",
                sheets: [{ title: "ProjectAlpha" }, { title: "ProjectBeta" }],
            } as any;

            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        range: "ProjectAlpha!A1:Z100",
                        values: [["Jira issue A", "https://saturam.atlassian.net/browse/DB-826"]],
                    },
                    {
                        range: "ProjectBeta!A1:Z100",
                        values: [
                            ["Confluence page B", "https://saturam.atlassian.net/wiki/spaces/Alkem/pages/231145593"],
                        ],
                    },
                ],
            });

            mockJiraSource.fetch.mockResolvedValue(
                makeDoc({ id: "DB-826", source: KnowledgeSourceType.JIRA, title: "DB-826 Ticket" }),
            );
            mockConfluenceSource.fetch.mockResolvedValue(
                makeDoc({ id: "231145593", source: KnowledgeSourceType.CONFLUENCE, title: "Confluence Page" }),
            );

            await service.sync(config, "/mock/cwd", "ProjectAlpha");

            // The sheet is still read (global onboardingSheets entries must still resolve so their
            // per-tab projects can be discovered), but only the matching tab's task is fetched.
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalled();
            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).not.toHaveBeenCalled();
        });
    });

    describe("uploadToS3", () => {
        const files: SyncedDocument[] = [
            {
                contentPath: "/mock/personal/onboarding/saturam/google-docs/doc.md",
                metadataAttributes: { title: "Doc", category: "google-docs", project: "saturam" },
            },
            {
                contentPath: "/mock/personal/onboarding/saturam/google-sheets/data.json",
                metadataAttributes: { title: "Data", category: "google-sheets", project: "saturam", rowCount: 5 },
            },
        ];

        it("does nothing and warns when there are no files to upload", async () => {
            const result = await service.uploadToS3([]);

            expect(result).toEqual({ uploaded: 0, skipped: 0, failed: 0 });
            expect(mockS3.putObject).not.toHaveBeenCalled();
        });

        it("uploads content + a Bedrock metadata sidecar per file, without any 'folder' marker object", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(false);
            (readFile as jest.Mock).mockResolvedValue(Buffer.from("content"));

            const result = await service.uploadToS3(files);

            expect(result).toEqual({ uploaded: 2, skipped: 0, failed: 0 });
            // S3 has no real directories — no key should ever be a bare "<prefix>/" marker.
            const uploadedKeys = (mockS3.putObject as jest.Mock).mock.calls.map((call) => call[0]);
            expect(uploadedKeys.some((k: string) => k.endsWith("/"))).toBe(false);

            // Content object
            expect(mockS3.putObject).toHaveBeenCalledWith(
                "saturam/google-docs/doc.md",
                expect.any(Buffer),
                "text/markdown",
            );
            // Bedrock-compliant metadata sidecar: exact key + ".metadata.json", wrapped in metadataAttributes
            expect(mockS3.putObject).toHaveBeenCalledWith(
                "saturam/google-docs/doc.md.metadata.json",
                JSON.stringify({ metadataAttributes: files[0].metadataAttributes }, null, 2),
                "application/json",
            );

            expect(mockS3.putObject).toHaveBeenCalledWith(
                "saturam/google-sheets/data.json",
                expect.any(Buffer),
                "application/json",
            );
            expect(mockS3.putObject).toHaveBeenCalledWith(
                "saturam/google-sheets/data.json.metadata.json",
                JSON.stringify({ metadataAttributes: files[1].metadataAttributes }, null, 2),
                "application/json",
            );

            // Never uploads a bare ".json" bookkeeping sidecar under the content's own basename —
            // that would be ingested by Bedrock as its own separate document.
            expect(mockS3.putObject).not.toHaveBeenCalledWith(
                "saturam/google-docs/doc.json",
                expect.anything(),
                expect.anything(),
            );
        });

        it("falls back to a flat 'external/<basename>' key for a contentPath outside the onboarding directory", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(false);
            (readFile as jest.Mock).mockResolvedValue(Buffer.from("content"));

            const escapingFile: SyncedDocument = {
                contentPath: "/tmp/custom-output/report.md",
                metadataAttributes: { title: "Report" },
            };

            await service.uploadToS3([escapingFile]);

            expect(mockS3.putObject).toHaveBeenCalledWith("external/report.md", expect.any(Buffer), "text/markdown");
            const uploadedKeys = (mockS3.putObject as jest.Mock).mock.calls.map((call) => call[0]);
            expect(uploadedKeys.some((k: string) => k.includes(".."))).toBe(false);
        });

        it("re-uploads content and metadata sidecar even if the key already exists in S3, so edits are never frozen out", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(true);
            (readFile as jest.Mock).mockResolvedValue(Buffer.from("content"));

            const result = await service.uploadToS3(files);

            expect(result).toEqual({ uploaded: 2, skipped: 0, failed: 0 });
            expect(mockS3.putObject).toHaveBeenCalled();
        });

        it("counts a file as failed if the upload throws, without stopping the rest", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(false);
            (readFile as jest.Mock).mockResolvedValue(Buffer.from("content"));
            (mockS3.putObject as jest.Mock)
                .mockRejectedValueOnce(new Error("Access Denied"))
                .mockResolvedValue(undefined);

            const result = await service.uploadToS3(files);

            expect(result).toEqual({ uploaded: 1, skipped: 0, failed: 1 });
        });
    });

    describe("listSyncedDocuments", () => {
        it("reports no documents when the onboarding directory is empty", async () => {
            (readdir as jest.Mock).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

            await service.listSyncedDocuments();

            // No throw — nothing more to assert since output only goes to the logger
        });

        it("groups documents by project name and category (project folder first, category nested inside)", async () => {
            (readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
                if (dirPath === "/mock/personal/onboarding") {
                    return [{ name: "saturam", isDirectory: () => true, isFile: () => false }];
                }
                if (dirPath === "/mock/personal/onboarding/saturam/google-docs") {
                    return [{ name: "golden-record.md", isDirectory: () => false, isFile: () => true }];
                }
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            });
            (readFile as jest.Mock).mockImplementation(async (filePath: string) => {
                if (filePath.endsWith(".json")) {
                    return JSON.stringify({ title: "Golden Record Management Talking Points" });
                }
                throw new Error("unexpected read");
            });

            await service.listSyncedDocuments();

            expect(readdir).toHaveBeenCalledWith("/mock/personal/onboarding", { withFileTypes: true });
            expect(readdir).toHaveBeenCalledWith("/mock/personal/onboarding/saturam/google-docs", {
                withFileTypes: true,
            });
        });

        it("lists project-less documents (synced without --project-name) under a category folder at the root", async () => {
            (readdir as jest.Mock).mockImplementation(async (dirPath: string) => {
                if (dirPath === "/mock/personal/onboarding") {
                    return [{ name: "confluence", isDirectory: () => true, isFile: () => false }];
                }
                if (dirPath === "/mock/personal/onboarding/confluence") {
                    return [{ name: "some-page.md", isDirectory: () => false, isFile: () => true }];
                }
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            });
            (readFile as jest.Mock).mockImplementation(async (filePath: string) => {
                if (filePath.endsWith(".json")) {
                    return JSON.stringify({ title: "Some Page" });
                }
                throw new Error("unexpected read");
            });

            await service.listSyncedDocuments();

            expect(readdir).toHaveBeenCalledWith("/mock/personal/onboarding/confluence", { withFileTypes: true });
        });
    });

    describe("resolveConfigFromSheet", () => {
        it("parses a structured project sheet (with a project_name column) into an OnboardConfig", async () => {
            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
                spreadsheetId: "projects-sheet-id",
                sheets: [{ title: "Sheet1" }],
            } as any);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        values: [
                            [
                                "project_name",
                                "confluence_base_url",
                                "confluence_pages",
                                "confluence_space",
                                "jira_base_url",
                                "jira_tickets",
                                "jira_jql",
                                "google_docs",
                                "google_sheet_id",
                                "google_sheet_range",
                                "onboarding_sheet_ids",
                            ],
                            [
                                "Saturam",
                                "https://saturam.atlassian.net",
                                "123456789,987654321",
                                "PROJ",
                                "https://saturam.atlassian.net",
                                "PROJ-123,PROJ-456",
                                "",
                                "doc-id-1",
                                "sheet-id-1",
                                "Sheet1!A1:E100",
                                "links-sheet-id",
                            ],
                            ["Acme", "", "", "ACME", "", "", "project = ACME AND status != Done", "", "", "", ""],
                            ["", "", "", "", "", "", "", "", "", "", ""],
                        ],
                    },
                ],
            } as any);

            const config = await service.resolveConfigFromSheet("projects-sheet-id");

            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("projects-sheet-id", ["'Sheet1'"]);
            // Base URLs are written into each project's own entry, not a shared top-level block —
            // otherwise two projects on different Atlassian sites would clobber each other's host.
            expect(config.confluence).toBeUndefined();
            expect(config.jira).toBeUndefined();
            expect(config.projects?.Saturam).toEqual({
                confluence: {
                    baseUrl: "https://saturam.atlassian.net",
                    pages: ["123456789", "987654321"],
                    space: "PROJ",
                },
                jira: { baseUrl: "https://saturam.atlassian.net", tickets: ["PROJ-123", "PROJ-456"] },
                googleDocs: { docs: ["doc-id-1"] },
                googleSheets: { spreadsheetId: "sheet-id-1", range: "Sheet1!A1:E100" },
                onboardingSheets: [{ spreadsheetId: "links-sheet-id" }],
            });
            expect(config.projects?.Acme).toEqual({
                confluence: { space: "ACME" },
                jira: { jql: "project = ACME AND status != Done" },
            });
            expect(Object.keys(config.projects ?? {})).toEqual(["Saturam", "Acme"]);
        });

        it("keeps each project's Atlassian base URL independent when two projects use different sites", async () => {
            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
                spreadsheetId: "projects-sheet-id",
                sheets: [{ title: "Sheet1" }],
            } as any);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        values: [
                            [
                                "project_name",
                                "confluence_base_url",
                                "confluence_pages",
                                "jira_base_url",
                                "jira_tickets",
                            ],
                            [
                                "Saturam",
                                "https://saturam.atlassian.net",
                                "111",
                                "https://saturam.atlassian.net",
                                "PROJ-1",
                            ],
                            ["Acme", "https://acme.atlassian.net", "222", "https://acme.atlassian.net", "ACME-1"],
                        ],
                    },
                ],
            } as any);

            const config = await service.resolveConfigFromSheet("projects-sheet-id");

            expect(config.projects?.Saturam?.confluence?.baseUrl).toBe("https://saturam.atlassian.net");
            expect(config.projects?.Saturam?.jira?.baseUrl).toBe("https://saturam.atlassian.net");
            expect(config.projects?.Acme?.confluence?.baseUrl).toBe("https://acme.atlassian.net");
            expect(config.projects?.Acme?.jira?.baseUrl).toBe("https://acme.atlassian.net");
        });

        it("falls back to sheet-of-links mode when there is no project_name column", async () => {
            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
                spreadsheetId: "links-only-sheet-id",
                sheets: [{ title: "Sheet1" }],
            } as any);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        values: [
                            ["Resource", "Link"],
                            ["Runbook", "https://saturam.atlassian.net/wiki/x"],
                        ],
                    },
                ],
            } as any);

            const config = await service.resolveConfigFromSheet("links-only-sheet-id");

            expect(config).toEqual({ onboardingSheets: [{ spreadsheetId: "links-only-sheet-id" }] });
        });
    });
});
