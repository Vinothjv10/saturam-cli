/**
 * Canonical domain type for a piece of knowledge fetched from any external source
 * (Jira, Confluence, Google Drive, etc.).
 * Used by KnowledgeSource adapters, OnboardService, and future indexing/ask features.
 */

/** Strongly-typed discriminator for the integration that produced a KnowledgeDocument. */
export enum KnowledgeSourceType {
    CONFLUENCE = "confluence",
    JIRA = "jira",
    GOOGLE_DOCS = "google-docs",
    GOOGLE_SHEETS = "google-sheets",
}

export interface KnowledgeDocument {
    id: string;
    source: KnowledgeSourceType;
    title: string;
    content: string;
    url: string;
    metadata: {
        updatedAt?: string;
        author?: string;
        labels?: string[];
    };
}

/**
 * Each integration (Jira, Confluence, Google Drive) provides one implementation
 * that maps raw API JSON → KnowledgeDocument.
 */
export interface KnowledgeSource {
    fetch(id: string, options?: Record<string, unknown>): Promise<KnowledgeDocument>;
}
