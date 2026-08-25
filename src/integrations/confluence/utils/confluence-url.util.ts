/**
 * Utility functions for parsing Confluence page URLs into structured parts.
 * Mirrors the github-url.util.ts pattern used by the SCM integrations.
 */

export interface ParsedConfluenceUrl {
    baseUrl: string;
    pageId: string;
}

/**
 * Extracts `baseUrl` and `pageId` from a Confluence page URL.
 *
 * Supports:
 *   - /wiki/spaces/<KEY>/pages/<id>   (Cloud & Server)
 *   - ?pageId=<id>                    (legacy query-param style)
 *   - /pages/<id>                     (short generic form)
 *
 * Returns `null` if the URL cannot be parsed or does not contain a page ID.
 */
export function parseConfluenceUrl(urlStr: string): ParsedConfluenceUrl | null {
    try {
        const url = new URL(urlStr);
        const spacePageMatch = url.pathname.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/i);
        if (spacePageMatch) {
            return { baseUrl: url.origin, pageId: spacePageMatch[1] };
        }
        const pageIdQuery = url.searchParams.get("pageId");
        if (pageIdQuery) {
            return { baseUrl: url.origin, pageId: pageIdQuery };
        }
        const generalPageMatch = url.pathname.match(/\/pages\/(\d+)/i);
        if (generalPageMatch) {
            return { baseUrl: url.origin, pageId: generalPageMatch[1] };
        }
        return null;
    } catch {
        return null;
    }
}
