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
            })),
        } as any;

        mockS3 = {
            getObject: jest.fn(),
            putObject: jest.fn().mockResolvedValue(undefined),
            listObjects: jest.fn().mockResolvedValue([]),
            objectExists: jest.fn().mockResolvedValue(false),
            ensurePrefixExists: jest.fn().mockResolvedValue(undefined),
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
        it("forces every task's output folder to the override, ignoring config-derived project names", async () => {
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

            await service.sync(config, "/mock/cwd", "Custom Project");

            const writeCall = (writeFile as jest.Mock).mock.calls.find((call) => String(call[0]).endsWith(".md"));
            expect(writeCall[0]).toContain("/custom-project/");
            expect(writeCall[0]).not.toContain("/myproject/");
        });

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
            const mockMeta = {
                spreadsheetId: "sheet-id-abc",
                title: "Spreadsheet Title",
                sheets: [{ properties: { title: "Sheet1" } }],
            } as any;
            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [{ range: "Sheet1!A:E", values: [["header1"], ["row1"]] }],
            });

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("sheet-id-abc");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-id-abc", ["Sheet1!A:E"]);
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
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

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("another-nested-sheet-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("another-nested-sheet-id", [
                "Sheet1",
            ]);

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
                "ProjectAlpha",
                "ProjectBeta",
            ]);

            // Verify that resolved tasks were parsed with correct projectNames (i.e. tab titles)
            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("231145593", {
                baseUrl: "https://saturam.atlassian.net",
            });

            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
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

        it("ensures each folder prefix exists, then uploads content + a Bedrock metadata sidecar per file", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(false);
            (readFile as jest.Mock).mockResolvedValue(Buffer.from("content"));

            const result = await service.uploadToS3(files);

            expect(result).toEqual({ uploaded: 2, skipped: 0, failed: 0 });
            expect(mockS3.ensurePrefixExists).toHaveBeenCalledWith("saturam/google-docs");
            expect(mockS3.ensurePrefixExists).toHaveBeenCalledWith("saturam/google-sheets");

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

        it("skips both content and metadata sidecar for files that already exist in S3", async () => {
            (mockS3.objectExists as jest.Mock).mockResolvedValue(true);

            const result = await service.uploadToS3(files);

            expect(result).toEqual({ uploaded: 0, skipped: 2, failed: 0 });
            expect(mockS3.putObject).not.toHaveBeenCalled();
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
});
