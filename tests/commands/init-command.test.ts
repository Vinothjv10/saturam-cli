import { InitCommand } from "../../src/commands/init-command";
import { CloudProvider, ConfigService } from "../../src/services/config-service";
import { select, input, password, confirm } from "@inquirer/prompts";

jest.mock("@inquirer/prompts", () => ({
    select: jest.fn(),
    input: jest.fn(),
    password: jest.fn(),
    confirm: jest.fn(),
    checkbox: jest.fn(),
}));

describe("InitCommand Platform Config Flow", () => {
    let command: InitCommand;
    let mockConfig: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConfig = {
            loadPersonalConfig: jest.fn().mockResolvedValue({}),
            savePersonalConfig: jest.fn().mockResolvedValue(undefined),
            getPersonalConfigPath: jest.fn().mockReturnValue("/mock/personal/config.json"),
        } as any;

        command = new InitCommand(mockConfig);
    });

    it("should configure Atlassian credentials from top-level menu", async () => {
        // New UX: single select → "atlassian" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("atlassian");
        (input as jest.Mock).mockResolvedValueOnce("test@example.com");
        (password as jest.Mock).mockResolvedValueOnce("secret_api_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(input).toHaveBeenCalled();
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            atlassianEmail: "test@example.com",
            atlassianToken: "secret_api_token",
        });
    });

    it("should configure Google credentials from top-level menu", async () => {
        // New UX: single select → "google" (no nested Onboarding submenu)
        (select as jest.Mock).mockResolvedValueOnce("google");
        (password as jest.Mock).mockResolvedValueOnce("ya29.google_token");

        await command.execute({});

        expect(select).toHaveBeenCalledTimes(1);
        expect(password).toHaveBeenCalled();
        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            googleAccessToken: "ya29.google_token",
        });
    });

    it("should configure AWS cloud (profile auth, no S3/KB) from top-level menu", async () => {
        // Menu selects: top-level "cloud" -> cloud provider "aws" -> auth method "profile"
        (select as jest.Mock)
            .mockResolvedValueOnce("cloud")
            .mockResolvedValueOnce(CloudProvider.AWS)
            .mockResolvedValueOnce("profile");
        // AWS profile name, then AWS region
        (input as jest.Mock).mockResolvedValueOnce("").mockResolvedValueOnce("us-west-2");
        // Skip S3 and Bedrock Knowledge Base configuration
        (confirm as jest.Mock).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

        await command.execute({});

        expect(mockConfig.savePersonalConfig).toHaveBeenCalledWith({
            cloud: {
                [CloudProvider.AWS]: {
                    enabled: true,
                    awsAuthMethod: "profile",
                    awsProfile: undefined,
                    awsRegion: "us-west-2",
                    awsAccessKeyId: undefined,
                    awsSecretAccessKey: undefined,
                    awsSessionToken: undefined,
                    s3: undefined,
                    bedrockKnowledgeBase: undefined,
                },
            },
            defaultCloudProvider: CloudProvider.AWS,
        });
    });
});
