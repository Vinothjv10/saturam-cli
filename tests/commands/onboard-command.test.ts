import { input } from "@inquirer/prompts";
import { OnboardCommand } from "../../src/commands/onboard-command";
import { OnboardService } from "../../src/services/onboarding/onboard.service";
import { ConfigService } from "../../src/services/config-service";
import { BedrockKnowledgeBaseService } from "../../src/integrations/aws/services/bedrock-knowledge-base.service";

jest.mock("@inquirer/prompts", () => ({
    input: jest.fn(),
}));

describe("OnboardCommand Dual-Mode Routing", () => {
    let command: OnboardCommand;
    let mockOnboardService: jest.Mocked<OnboardService>;
    let mockConfigService: jest.Mocked<ConfigService>;
    let mockKnowledgeBase: jest.Mocked<BedrockKnowledgeBaseService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockOnboardService = {
            sync: jest.fn().mockResolvedValue({ filesWritten: [] }),
            uploadToS3: jest.fn().mockResolvedValue({ uploaded: 0, skipped: 0, failed: 0 }),
            listSyncedDocuments: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockConfigService = {
            loadOnboardingConfig: jest.fn().mockResolvedValue({
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            }),
        } as any;

        mockKnowledgeBase = {
            retrieve: jest.fn().mockResolvedValue([]),
        } as any;

        command = new OnboardCommand(mockOnboardService, mockConfigService, mockKnowledgeBase);
    });

    it("should route to Google Sheet mode when passed a Google Sheets URL", async () => {
        await command.execute({
            configOrSheet: "https://docs.google.com/spreadsheets/d/1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg/edit",
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            expect.any(String),
            undefined,
        );
    });

    it("should route to Google Sheet mode when passed a 44-character Google Sheet ID", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            expect.any(String),
            undefined,
        );
    });

    it("should default to local config mode when no argument is passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(
            expect.stringContaining(".sateng/onboarding.json"),
        );
        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            expect.any(String),
            undefined,
        );
    });

    it("should pass the --project-name override through to OnboardService.sync in config mode", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": "custom-project",
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            expect.any(String),
            "custom-project",
        );
    });

    it("should pass the --project-name override through to OnboardService.sync in Google Sheet mode", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
            "project-name": "custom-project",
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            expect.any(String),
            "custom-project",
        );
    });

    it("should call uploadToS3 with the files written when --upload-to-s3 is passed", async () => {
        const filesWritten = [
            {
                contentPath: "/mock/onboarding/saturam/google-docs/doc.md",
                metadataAttributes: { title: "Doc", category: "google-docs", project: "saturam" },
            },
        ];
        (mockOnboardService.sync as jest.Mock).mockResolvedValue({ filesWritten });

        await command.execute({
            configOrSheet: undefined,
            "project-name": "Saturam",
            "upload-to-s3": true,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.uploadToS3).toHaveBeenCalledWith(filesWritten);
    });

    it("should not call uploadToS3 when --upload-to-s3 is not passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.uploadToS3).not.toHaveBeenCalled();
    });

    it("should route to listSyncedDocuments and skip syncing when --list is passed", async () => {
        await command.execute({
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: true,
            "knowledge-base": undefined,
        });

        expect(mockOnboardService.listSyncedDocuments).toHaveBeenCalledTimes(1);
        expect(mockOnboardService.sync).not.toHaveBeenCalled();
        expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
    });

    describe("--knowledge-base interactive search", () => {
        it("skips syncing entirely and enters the search loop", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
            });

            expect(mockOnboardService.sync).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
            expect(input).toHaveBeenCalledTimes(1);
        });

        it("exits immediately on blank input", async () => {
            (input as jest.Mock).mockResolvedValueOnce("   ");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
            });

            expect(mockKnowledgeBase.retrieve).not.toHaveBeenCalled();
        });

        it("exits on 'exit' or 'quit' (case-insensitive)", async () => {
            (input as jest.Mock).mockResolvedValueOnce("EXIT");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
            });

            expect(mockKnowledgeBase.retrieve).not.toHaveBeenCalled();
        });

        it("treats Ctrl+C as a normal exit", async () => {
            const exitError = new Error("User force closed the prompt");
            exitError.name = "ExitPromptError";
            (input as jest.Mock).mockRejectedValueOnce(exitError);

            await expect(
                command.execute({
                    configOrSheet: undefined,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": true,
                }),
            ).resolves.toBeUndefined();

            expect(mockKnowledgeBase.retrieve).not.toHaveBeenCalled();
        });

        it("retrieves results for each question until exit", async () => {
            (input as jest.Mock)
                .mockResolvedValueOnce("what is the auth flow?")
                .mockResolvedValueOnce("what is onboarding?")
                .mockResolvedValueOnce("");
            (mockKnowledgeBase.retrieve as jest.Mock)
                .mockResolvedValueOnce([{ content: "chunk one", score: 0.9, location: "s3://bucket/key.md" }])
                .mockResolvedValueOnce([]);

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
            });

            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledTimes(2);
            expect(mockKnowledgeBase.retrieve).toHaveBeenNthCalledWith(1, "what is the auth flow?");
            expect(mockKnowledgeBase.retrieve).toHaveBeenNthCalledWith(2, "what is onboarding?");
        });

        it("logs an error and keeps looping when retrieve throws", async () => {
            (input as jest.Mock).mockResolvedValueOnce("bad query").mockResolvedValueOnce("");
            (mockKnowledgeBase.retrieve as jest.Mock).mockRejectedValueOnce(new Error("KB not configured"));

            await expect(
                command.execute({
                    configOrSheet: undefined,
                    "project-name": undefined,
                    "upload-to-s3": undefined,
                    list: undefined,
                    "knowledge-base": true,
                }),
            ).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });
    });
});
