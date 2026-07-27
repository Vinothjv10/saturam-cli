import { OnboardCommand } from "../../src/commands/onboard-command";
import { OnboardService } from "../../src/services/onboarding/onboard.service";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
jest.mock("fs", () => {
    const actualFs = jest.requireActual("fs");
    return {
        ...actualFs,
        existsSync: jest.fn(),
    };
});

jest.mock("fs/promises", () => {
    const actualFsPromises = jest.requireActual("fs/promises");
    return {
        ...actualFsPromises,
        readFile: jest.fn(),
    };
});

describe("OnboardCommand Dual-Mode Routing", () => {
    let command: OnboardCommand;
    let mockOnboardService: jest.Mocked<OnboardService>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockOnboardService = {
            sync: jest.fn().mockResolvedValue(undefined),
        } as any;

        command = new OnboardCommand(mockOnboardService);
    });

    it("should route to Google Sheet mode when passed a Google Sheets URL", async () => {
        await command.execute({
            configOrSheet: "https://docs.google.com/spreadsheets/d/1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg/edit",
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [
                    { spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" },
                ],
            },
            expect.any(String)
        );
    });

    it("should route to Google Sheet mode when passed a 44-character Google Sheet ID", async () => {
        await command.execute({
            configOrSheet: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg",
        });

        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                onboardingSheets: [
                    { spreadsheetId: "1JIUzDWt7QghYyaNTY_KyDBe1GB7iV_TzNnFBjA3oawg" },
                ],
            },
            expect.any(String)
        );
    });

    it("should default to local config mode when no argument is passed", async () => {
        (existsSync as jest.Mock).mockReturnValue(true);
        (readFile as jest.Mock).mockResolvedValue(
            JSON.stringify({
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            })
        );

        await command.execute({ configOrSheet: undefined });

        expect(existsSync).toHaveBeenCalled();
        expect(readFile).toHaveBeenCalled();
        expect(mockOnboardService.sync).toHaveBeenCalledWith(
            {
                confluence: { baseUrl: "https://saturam.atlassian.net" },
            },
            expect.any(String)
        );
    });
});
