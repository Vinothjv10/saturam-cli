import { getLogger } from "log4js";
import { Service } from "typedi";
import { JiraService } from "../../integrations/jira/services/jira.service";
import { JiraComment } from "../../integrations/jira/models/jira.model";
import { AdfNormalizerService } from "../normalizers/adf-normalizer.service";
import { KnowledgeDocument, KnowledgeSource, KnowledgeSourceType } from "./knowledge-source.model";

const logger = getLogger("JiraKnowledgeSource");

/**
 * Adapter that maps a raw Jira issue (via JiraService) into a KnowledgeDocument.
 * This class owns the fetch → normalize → KnowledgeDocument mapping.
 *
 * Any feature that needs "a Jira issue as a KnowledgeDocument" (onboarding, indexing, ask)
 * should call this adapter.
 */
@Service()
export class JiraKnowledgeSource implements KnowledgeSource {
    constructor(
        private readonly jira: JiraService,
        private readonly adf: AdfNormalizerService,
    ) {}

    public async fetch(id: string, options?: { baseUrl?: string }): Promise<KnowledgeDocument> {
        const baseUrl = options?.baseUrl ?? "";

        if (!id) {
            throw new Error("Jira ticket key is missing or invalid.");
        }
        if (!baseUrl) {
            throw new Error(`No base URL configured for Jira ticket: ${id}`);
        }

        logger.info(`Fetching Jira ticket ${id} from ${baseUrl}...`);

        // 1. Fetch raw API response
        const data = await this.jira.getIssue(baseUrl, id);
        const fields = data.fields;

        // 2. Extract plain metadata fields
        const summary = fields?.summary || "No Summary";
        const status = fields?.status?.name || "Unknown";
        const assignee = fields?.assignee?.displayName || "Unassigned";
        const reporter = fields?.reporter?.displayName || "Unassigned";
        const priority = fields?.priority?.name || "Medium";
        const issueType = fields?.issuetype?.name || "Task";
        const created = fields?.created || "";
        const updated = fields?.updated || "";
        const labels = fields?.labels || [];

        // 3. ADF → Markdown via normalizer
        const description = (() => {
            try {
                return fields?.description ? this.adf.renderAdfNode(fields.description) : "";
            } catch (err) {
                logger.error(`Failed to render description ADF for Jira ticket ${id}: ${(err as Error).message}`);
                return "_Normalization Failed — see logs for details_";
            }
        })();

        // The comments embedded in getIssue()'s response are capped at Jira's default page
        // size — fetch the full, paginated list separately so long comment threads aren't
        // silently truncated.
        const totalComments = fields?.comment?.total ?? 0;
        const rawComments: JiraComment[] =
            totalComments > (fields?.comment?.comments?.length ?? 0)
                ? await this.jira.listAllComments(baseUrl, id)
                : fields?.comment?.comments || [];
        const commentsMarkdown = rawComments.map((c) => {
            const author = c.author?.displayName || "User";
            const date = this.formatDate(c.created);
            const body = (() => {
                try {
                    return c.body ? this.adf.renderAdfNode(c.body) : "";
                } catch (err) {
                    logger.error(`Failed to render comment ADF for Jira ticket ${id}: ${(err as Error).message}`);
                    return "_Normalization Failed — see logs for details_";
                }
            })();
            return `**Comment by ${author}** (${date}):\n${body}\n`;
        });

        // 4. Build final Markdown content
        const docUrl = `${baseUrl.replace(/\/$/, "")}/browse/${id}`;
        const content =
            `
# [${id}] ${summary}

| Field | Value |
| :--- | :--- |
| **Type** | ${issueType} |
| **Status** | ${status} |
| **Priority** | ${priority} |
| **Assignee** | ${assignee} |
| **Reporter** | ${reporter} |
| **Created** | ${created} |
| **Updated** | ${updated} |
| **Link** | [Open in Jira](${docUrl}) |

## Description
${description || "_No Description_"}

${commentsMarkdown.length > 0 ? `## Comments\n\n${commentsMarkdown.join("\n")}` : ""}
`.trim() + "\n";

        // 5. Return KnowledgeDocument
        return {
            id,
            source: KnowledgeSourceType.JIRA,
            title: summary,
            content,
            url: docUrl,
            metadata: {
                updatedAt: updated,
                author: reporter !== "Unassigned" ? reporter : assignee,
                labels,
            },
        };
    }

    /** Safely formats a Jira date string, returning "" for missing/invalid input instead of throwing. */
    private formatDate(value: string | undefined): string {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }
}
