import { OnboardCommand } from "../../src/commands/onboard-command";
import { OnboardService } from "../../src/services/onboarding/onboard.service";
import { ConfigService } from "../../src/services/config-service";

describe("OnboardCommand Dual-Mode Routing", () => {
    let command: OnboardCommand;
    let mockOnboardService: jest.Mocked<OnboardService>;
    let mockConfigService: jest.Mocked<ConfigService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockOnboardService = {
            sync: jest.fn().mockResolvedValue(undefined),
        } as any;

        mockConfigService = {
            loadOnboardingConfig: jest.fn().mockResolvedValue({
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            }),
        } as any;

        command = new OnboardCommand(mockOnboardService, mockConfigService);
    });

    it("should route to Google Sheet mode when passed a Google Sheets URL", async () => {
        await command.execute({
            configOrSheet: "https://docs.google.com/spreadsheets/d/1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg/edit",
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            expect.any(String),
        );
    });

    it("should route to Google Sheet mode when passed a 44-character Google Sheet ID", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [{ spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" }],
            },
            expect.any(String),
        );
    });

    it("should default to local config mode when no argument is passed", async () => {
        await command.execute({ configOrSheet: undefined });

        expect(mockConfigService.loadOnboardingConfig).toHaveBeenCalledWith(
            expect.stringContaining(".sateng/onboarding.json"),
        );
        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            expect.any(String),
        );
    });
});
