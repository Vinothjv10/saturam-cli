import { OnboardService } from "../../../src/services/onboarding/onboard.service";
import { ConfluenceService } from "../../../src/integrations/confluence/services/confluence.service";
import { JiraService } from "../../../src/integrations/jira/services/jira.service";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";
import { ConfigService } from "../../../src/services/config-service";
import { JiraKnowledgeSource } from "../../../src/services/knowledge/jira-knowledge.source";
import { ConfluenceKnowledgeSource } from "../../../src/services/knowledge/confluence-knowledge.source";
import { GoogleDriveKnowledgeSource } from "../../../src/services/knowledge/google-drive-knowledge.source";
import { KnowledgeDocument } from "../../../src/services/knowledge/knowledge-source.model";
import { mkdir, writeFile } from "fs/promises";

jest.mock("fs/promises", () => ({
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
}));

// Helpers to build minimal KnowledgeDocuments in tests
const makeDoc = (overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
    id: "test-id",
    source: "jira",
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

        service = new OnboardService(
            mockConfluence,
            mockJira,
            mockGoogleDrive,
            mockConfig,
            mockJiraSource,
            mockConfluenceSource,
            mockGoogleDriveSource,
        );
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
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
                source: "confluence",
                title: "Test Confluence Page",
                content: "# Test Confluence Page\n",
                url: "https://confluence.example.com/wiki/spaces/TST/pages/123",
            });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("123", { baseUrl: "https://confluence.example.com" });
            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
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

            const doc = makeDoc({ source: "confluence", title: "Mocked Page" });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            // Should delegate pagination to the service helper, not call listPagesInSpace directly
            expect(mockConfluence.listAllPagesInSpace).toHaveBeenCalledWith(
                "https://confluence.example.com",
                "TST",
            );
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
            const doc = makeDoc({ source: "confluence", title: "Project Page" });
            mockConfluenceSource.fetch.mockResolvedValue(doc);

            await service.sync(config, "/mock/cwd");

            expect(mockConfluence.listAllPagesInSpace).toHaveBeenCalledWith(
                "https://confluence.example.com",
                "PROJ",
            );
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
                source: "jira",
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

            const doc = makeDoc({ source: "jira", title: "Jira Ticket" });
            mockJiraSource.fetch.mockResolvedValue(doc);

            await service.sync(config as any, "/mock/cwd");

            // Should delegate pagination to the service helper, not call searchIssues directly
            expect(mockJira.listAllIssuesByJql).toHaveBeenCalledWith(
                "https://jira.example.com",
                "project = TST",
            );
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
                source: "googleDocs",
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
                valueRanges: [
                    { range: "Sheet1!A:E", values: [["header1"], ["row1"]] },
                ],
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
                                    ["Confluence page", "https://saturam.atlassian.net/wiki/spaces/Alkem/pages/231145593"],
                                    ["Google Doc", "https://docs.google.com/document/d/1FZv2bZ1KIVTGRWtK63w3oC25sr1UiPSN"],
                                    ["Google Sheet", "https://docs.google.com/spreadsheets/d/another-nested-sheet-id/edit"],
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
                                values: [
                                    ["header1"],
                                    ["val1"],
                                ],
                            },
                        ],
                    } as any;
                }
                return {} as any;
            });

            mockJiraSource.fetch.mockResolvedValue(
                makeDoc({ id: "DB-826", source: "jira", title: "DB-826 Ticket" })
            );
            mockConfluenceSource.fetch.mockResolvedValue(
                makeDoc({ id: "231145593", source: "confluence", title: "Confluence Page" })
            );
            mockGoogleDriveSource.fetch.mockResolvedValue(
                makeDoc({ id: "1FZv2bZ1KIVTGRWtK63w3oC25sr1UiPSN", source: "google-drive", title: "Google Doc Spec" })
            );

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("sheet-links-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-links-id", ["LinksSheet!A:B"]);

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("another-nested-sheet-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("another-nested-sheet-id", ["Sheet1"]);

            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("231145593", { baseUrl: "https://saturam.atlassian.net" });
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
                sheets: [
                    { title: "ProjectAlpha" },
                    { title: "ProjectBeta" },
                ],
            } as any;

            mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue(mockMeta);
            mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
                valueRanges: [
                    {
                        range: "ProjectAlpha!A1:Z100",
                        values: [
                            ["Jira issue A", "https://saturam.atlassian.net/browse/DB-826"],
                        ],
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
                makeDoc({ id: "DB-826", source: "jira", title: "DB-826 Ticket" })
            );
            mockConfluenceSource.fetch.mockResolvedValue(
                makeDoc({ id: "231145593", source: "confluence", title: "Confluence Page" })
            );

            await service.sync(config, "/mock/cwd");

            expect(mockGoogleDrive.getSpreadsheetMetadata).toHaveBeenCalledWith("multi-tab-sheet-id");
            expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("multi-tab-sheet-id", [
                "ProjectAlpha",
                "ProjectBeta",
            ]);

            // Verify that resolved tasks were parsed with correct projectNames (i.e. tab titles)
            expect(mockJiraSource.fetch).toHaveBeenCalledWith("DB-826", { baseUrl: "https://saturam.atlassian.net" });
            expect(mockConfluenceSource.fetch).toHaveBeenCalledWith("231145593", { baseUrl: "https://saturam.atlassian.net" });

            expect(mkdir).toHaveBeenCalled();
            expect(writeFile).toHaveBeenCalled();
        });
    });
});
