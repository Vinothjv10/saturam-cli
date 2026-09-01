import { input } from "@inquirer/prompts";
import { OnboardCommand } from "../../src/commands/onboard-command";
import { OnboardService } from "../../src/services/onboarding/onboard.service";
import { ConfigService } from "../../src/services/config-service";
import { BedrockKnowledgeBaseService } from "../../src/integrations/aws/services/bedrock-knowledge-base.service";
import { LlmService } from "../../src/services/llm-service";

jest.mock("@inquirer/prompts", () => ({
    input: jest.fn(),
}));

describe("OnboardCommand Dual-Mode Routing", () => {
    let command: OnboardCommand;
    let mockOnboardService: jest.Mocked<OnboardService>;
    let mockConfigService: jest.Mocked<ConfigService>;
    let mockKnowledgeBase: jest.Mocked<BedrockKnowledgeBaseService>;
    let mockLlmService: jest.Mocked<LlmService>;

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
            hasAnyLLMProviderConfigured: jest.fn().mockResolvedValue(true),
        } as any;

        mockKnowledgeBase = {
            retrieve: jest.fn().mockResolvedValue([]),
        } as any;

        mockLlmService = {
            prompt: jest.fn().mockResolvedValue("Here is the answer."),
        } as any;

        command = new OnboardCommand(mockOnboardService, mockConfigService, mockKnowledgeBase, mockLlmService);
    });

    it("should route to Google Sheet mode when passed a Google Sheets URL", async () => {
        await command.execute({
            configOrSheet: "https://docs.google.com/spreadsheets/d/1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg/edit",
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
            chat: undefined,
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
                chat: undefined,
            });

            expect(mockOnboardService.sync).not.toHaveBeenCalled();
            expect(mockConfigService.loadOnboardingConfig).not.toHaveBeenCalled();
            expect(input).toHaveBeenCalledTimes(1);
            expect(input).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: "Ask Saturam-Cli :",
                    theme: { prefix: { idle: "🤖", done: "🤖" } },
                }),
            );
        });

        it("exits immediately on blank input", async () => {
            (input as jest.Mock).mockResolvedValueOnce("   ");

            await command.execute({
                configOrSheet: undefined,
                "project-name": undefined,
                "upload-to-s3": undefined,
                list: undefined,
                "knowledge-base": true,
                chat: undefined,
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
                chat: undefined,
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
                    chat: undefined,
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
                chat: undefined,
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
                    chat: undefined,
                }),
            ).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });
    });

    describe("--chat RAG search", () => {
        const chatInputs = {
            configOrSheet: undefined,
            "project-name": undefined,
            "upload-to-s3": undefined,
            list: undefined,
            "knowledge-base": undefined,
            chat: true,
        };

        it("shows a setup suggestion and skips everything else when no LLM provider is configured", async () => {
            (mockConfigService.hasAnyLLMProviderConfigured as jest.Mock).mockResolvedValue(false);

            await command.execute(chatInputs);

            expect(input).not.toHaveBeenCalled();
            expect(mockKnowledgeBase.retrieve).not.toHaveBeenCalled();
            expect(mockLlmService.prompt).not.toHaveBeenCalled();
            expect(mockOnboardService.sync).not.toHaveBeenCalled();
        });

        it("retrieves context, sends it plus the question to the LLM, and prints the answer", async () => {
            const stdoutIsTTY = process.stdout.isTTY;
            Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
            (input as jest.Mock).mockResolvedValueOnce("what is the auth flow?").mockResolvedValueOnce("");
            (mockKnowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
                { content: "auth uses OAuth2", score: 0.95, location: "s3://bucket/auth.md" },
                { content: "more auth context", score: 0.92, location: "s3://bucket/auth.md" },
            ]);
            (mockLlmService.prompt as jest.Mock).mockResolvedValueOnce("The auth flow uses OAuth2. [1]");

            try {
                await command.execute(chatInputs);
            } finally {
                Object.defineProperty(process.stdout, "isTTY", { value: stdoutIsTTY, configurable: true });
            }

            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("what is the auth flow?");
            expect(mockLlmService.prompt).toHaveBeenCalledTimes(1);
            const [messages] = (mockLlmService.prompt as jest.Mock).mock.calls[0];
            expect(messages).toHaveLength(2);
            expect(String(messages[1].content)).toContain("auth uses OAuth2");
            expect(String(messages[1].content)).toContain("what is the auth flow?");
            expect((command as any).renderAnswer("The auth flow uses OAuth2. [1]")).toBe("The auth flow uses OAuth2.");
        });

        it("normalizes --project and scopes both Bedrock retrieval and the LLM prompt", async () => {
            (input as jest.Mock).mockResolvedValueOnce("give me the overview").mockResolvedValueOnce("");
            (mockKnowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
                {
                    content: "Saturam Core overview",
                    location: "s3://bucket/saturam-core/google-docs/overview.md",
                },
            ]);

            await command.execute({ ...chatInputs, project: "Saturam Core" });

            expect(mockKnowledgeBase.retrieve).toHaveBeenCalledWith("give me the overview", {
                project: "saturam-core",
            });
            const [messages] = (mockLlmService.prompt as jest.Mock).mock.calls[0];
            expect(String(messages[0].content)).toContain('selected project "saturam-core"');
            expect(String(messages[1].content)).toContain("Selected project: saturam-core");
        });

        it("shows a terminal loading spinner while waiting for the chat answer", async () => {
            const originalIsTTY = process.stderr.isTTY;
            const writeSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
            Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

            try {
                (input as jest.Mock).mockResolvedValueOnce("what is onboarding?").mockResolvedValueOnce("");
                (mockKnowledgeBase.retrieve as jest.Mock).mockResolvedValueOnce([
                    { content: "onboarding docs", score: 0.9, location: "s3://bucket/onboarding.md" },
                ]);

                let resolveAnswer!: (answer: string) => void;
                (mockLlmService.prompt as jest.Mock).mockImplementationOnce(
                    () =>
                        new Promise<string>((resolve) => {
                            resolveAnswer = resolve;
                        }),
                );

                const run = command.execute(chatInputs);
                for (let i = 0; i < 10 && !resolveAnswer; i += 1) {
                    await Promise.resolve();
                }

                expect(writeSpy).toHaveBeenCalledWith(
                    expect.stringContaining("Retrieving context and generating answer"),
                );

                resolveAnswer("Onboarding is documented. [1]");
                await run;

                expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^\r\s+\r$/));
            } finally {
                Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
                writeSpy.mockRestore();
            }
        });

        it("logs an error and keeps looping when the LLM call throws", async () => {
            (input as jest.Mock).mockResolvedValueOnce("bad query").mockResolvedValueOnce("");
            (mockLlmService.prompt as jest.Mock).mockRejectedValueOnce(new Error("No API key found"));

            await expect(command.execute(chatInputs)).resolves.toBeUndefined();

            expect(input).toHaveBeenCalledTimes(2);
        });

        it("exits immediately on blank input without calling retrieve or the LLM", async () => {
            (input as jest.Mock).mockResolvedValueOnce("");

            await command.execute(chatInputs);

            expect(mockKnowledgeBase.retrieve).not.toHaveBeenCalled();
            expect(mockLlmService.prompt).not.toHaveBeenCalled();
        });
    });
});
