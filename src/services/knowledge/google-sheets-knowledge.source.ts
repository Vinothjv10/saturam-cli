import { getLogger } from "log4js";
import { Service } from "typedi";
import { GoogleDriveService } from "../../integrations/google-drive/services/google-drive.service";
import { KnowledgeDocument, KnowledgeSource, KnowledgeSourceType } from "./knowledge-source.model";

const logger = getLogger("GoogleSheetsKnowledgeSource");

/**
 * Adapter that maps a Google Sheets spreadsheet into a KnowledgeDocument.
 * Follows the same KnowledgeSource port pattern as ConfluenceKnowledgeSource,
 * JiraKnowledgeSource, and GoogleDriveKnowledgeSource.
 *
 * The produced `content` is a Markdown table of the spreadsheet data (first sheet by default).
 * The raw rows are embedded in `metadata` for downstream tooling.
 */
@Service()
export class GoogleSheetsKnowledgeSource implements KnowledgeSource {
    constructor(private readonly googleDrive: GoogleDriveService) {}

    public async fetch(id: string, options?: { range?: string }): Promise<KnowledgeDocument> {
        if (!id) {
            throw new Error("Google Sheets spreadsheet ID is missing or invalid.");
        }

        logger.info(`Fetching Google Sheet ${id}...`);

        // 1. Fetch spreadsheet metadata (title, available sheet tabs)
        const spreadsheet = await this.googleDrive.getSpreadsheetMetadata(id);
        const title = spreadsheet.title ?? id;
        const firstSheetTitle = spreadsheet.sheets?.[0]?.title ?? "Sheet1";
        const effectiveRange = options?.range ?? firstSheetTitle;

        // 2. Fetch cell values
        const batchData = await this.googleDrive.batchGetSpreadsheetValues(id, [effectiveRange]);
        const allRows = batchData.valueRanges?.[0]?.values ?? [];

        if (allRows.length === 0) {
            logger.warn(`Google Sheet "${title}" range "${effectiveRange}" returned no data.`);
        }

        // 3. Build Markdown table content
        const headers: string[] = Array.isArray(allRows[0]) ? (allRows[0] as string[]) : [];
        const dataRows = allRows.slice(1);

        const headerRow = headers.length > 0 ? `| ${headers.join(" | ")} |` : "";
        const separatorRow = headers.length > 0 ? `| ${headers.map(() => "---").join(" | ")} |` : "";
        const dataMarkdown = dataRows
            .map((row) => {
                const cells = headers.map((_, i) => String((row as string[])[i] ?? ""));
                return `| ${cells.join(" | ")} |`;
            })
            .join("\n");

        const tableMarkdown =
            headerRow && separatorRow ? [headerRow, separatorRow, dataMarkdown].filter(Boolean).join("\n") : "";

        const content =
            `# ${title}\n\n` +
            `_Sheet: ${effectiveRange} — ${dataRows.length} data row(s)_\n\n` +
            (tableMarkdown || "_No data found_") +
            "\n";

        // 4. Return KnowledgeDocument
        return {
            id,
            source: KnowledgeSourceType.GOOGLE_SHEETS,
            title,
            content,
            url: `https://docs.google.com/spreadsheets/d/${id}`,
            metadata: {
                updatedAt: new Date().toISOString(),
            },
        };
    }
}
