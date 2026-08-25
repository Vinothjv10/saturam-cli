/**
 * Utility functions for parsing Google Drive / Docs / Sheets URLs.
 * Mirrors the github-url.util.ts pattern used by the SCM integrations.
 */

/**
 * Extracts the Google Document ID from a Google Docs URL.
 *
 * Supports:
 *   - https://docs.google.com/document/d/<id>/edit
 *   - https://docs.google.com/document/d/<id>/view
 *
 * Returns `null` if the URL is not a Google Docs URL or no ID can be found.
 */
export function parseGoogleDocUrl(urlStr: string): string | null {
    try {
        const url = new URL(urlStr);
        if (!url.hostname.includes("docs.google.com")) return null;
        const match = url.pathname.match(/\/document\/d\/([a-zA-Z0-9-_]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Extracts the spreadsheet ID from a Google Sheets URL.
 *
 * Supports:
 *   - https://docs.google.com/spreadsheets/d/<id>/edit
 *   - https://docs.google.com/spreadsheets/d/<id>
 *
 * Returns `null` if the URL is not a Google Sheets URL or no ID can be found.
 */
export function parseGoogleSheetUrl(urlStr: string): string | null {
    try {
        const url = new URL(urlStr);
        if (!url.hostname.includes("docs.google.com")) return null;
        const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}
