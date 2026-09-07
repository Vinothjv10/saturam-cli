import { GoogleSheetsKnowledgeSource } from "../../../src/services/knowledge/google-sheets-knowledge.source";
import { GoogleDriveService } from "../../../src/integrations/google-drive/services/google-drive.service";

describe("GoogleSheetsKnowledgeSource", () => {
    let source: GoogleSheetsKnowledgeSource;
    let mockGoogleDrive: jest.Mocked<GoogleDriveService>;

    beforeEach(() => {
        mockGoogleDrive = {
            getSpreadsheetMetadata: jest.fn(),
            batchGetSpreadsheetValues: jest.fn(),
        } as any;
        source = new GoogleSheetsKnowledgeSource(mockGoogleDrive);
    });

    it("builds a Markdown table and returns raw rows for the default (first) tab", async () => {
        mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
            title: "Team Roster",
            sheets: [{ title: "Sheet1" }],
            modifiedTime: "2026-05-01T00:00:00.000Z",
        } as any);
        mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
            valueRanges: [
                {
                    values: [
                        ["Name", "Role"],
                        ["Alice", "Engineer"],
                    ],
                },
            ],
        } as any);

        const doc = await source.fetch("sheet-id");

        expect(doc.title).toBe("Team Roster");
        expect(doc.content).toContain("| Name | Role |");
        expect(doc.content).toContain("| Alice | Engineer |");
        expect(doc.sheetRows).toEqual([
            ["Name", "Role"],
            ["Alice", "Engineer"],
        ]);
        expect(doc.metadata.updatedAt).toBe("2026-05-01T00:00:00.000Z");
    });

    it("quotes the default tab title in the A1 range, since a raw title with a space is invalid A1 syntax", async () => {
        mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
            title: "Team Roster",
            sheets: [{ title: "My Tab" }],
        } as any);
        mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
            valueRanges: [{ values: [] }],
        } as any);

        await source.fetch("sheet-id");

        expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-id", ["'My Tab'"]);
    });

    it("uses a user-supplied range as-is, without quoting it", async () => {
        mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
            title: "Team Roster",
            sheets: [{ title: "Sheet1" }],
        } as any);
        mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
            valueRanges: [{ values: [] }],
        } as any);

        await source.fetch("sheet-id", { range: "Sheet1!A1:E100" });

        expect(mockGoogleDrive.batchGetSpreadsheetValues).toHaveBeenCalledWith("sheet-id", ["Sheet1!A1:E100"]);
    });

    it("falls back to the current time only when Drive doesn't report a modifiedTime", async () => {
        mockGoogleDrive.getSpreadsheetMetadata.mockResolvedValue({
            title: "Untimed Sheet",
            sheets: [{ title: "Sheet1" }],
        } as any);
        mockGoogleDrive.batchGetSpreadsheetValues.mockResolvedValue({
            valueRanges: [{ values: [] }],
        } as any);

        const doc = await source.fetch("sheet-id");

        expect(doc.metadata.updatedAt).toBeTruthy();
    });

    it("throws when the spreadsheet ID is missing", async () => {
        await expect(source.fetch("")).rejects.toThrow("Google Sheets spreadsheet ID is missing or invalid.");
    });
});
