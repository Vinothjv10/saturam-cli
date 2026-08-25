import { getLogger } from "log4js";
import { Service } from "typedi";
import { ConfigService } from "../../../services/config-service";
import { JIRA_API_PATH } from "../constants/jira.constant";
import { fetchWithTimeout } from "../../../utils/fetch-with-timeout";
import {
    JiraBoardsApiResponse,
    JiraIssueApiResponse,
    JiraProjectsApiResponse,
    JiraSearchApiResponse,
    JiraSprintsApiResponse,
} from "../models/jira.model";

const logger = getLogger("JiraService");

@Service()
export class JiraService {
    constructor(private readonly config: ConfigService) {}

    // --- Private helpers ---

    private getApiBase(baseUrl: string): string {
        return baseUrl.trim().replace(/\/$/, "") + JIRA_API_PATH;
    }

    private async getHeaders(): Promise<Record<string, string>> {
        const credentials = await this.config.getJiraCredentials();
        if (credentials.email) {
            return {
                Accept: "application/json",
                Authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`,
            };
        }
        return {
            Accept: "application/json",
            Authorization: `Bearer ${credentials.token}`,
        };
    }

    // --- Issue operations ---

    /**
     * Fetch a single Jira issue by key.
     * Returns the raw API response — description and comments are in native ADF format.
     * Pass the result to AdfNormalizerService if Markdown conversion is needed.
     */
    public async getIssue(baseUrl: string, issueKey: string): Promise<JiraIssueApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const url = `${apiBase}/issue/${issueKey}`;

        logger.debug(`Fetching Jira issue ${issueKey} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Jira issue ${issueKey}: ${response.status} ${response.statusText} - ${text}`,
            );
        }

        return response.json() as Promise<JiraIssueApiResponse>;
    }

    /**
     * Fetch metadata for a single Jira issue (no description, no comments).
     */
    public async getIssueMetadata(baseUrl: string, issueKey: string): Promise<JiraIssueApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const fields = "summary,status,assignee,reporter,priority,issuetype,created,updated,labels,project";
        const url = `${apiBase}/issue/${issueKey}?fields=${encodeURIComponent(fields)}`;

        logger.debug(`Fetching metadata for Jira issue ${issueKey} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch Jira issue metadata ${issueKey}: ${response.status} ${response.statusText} - ${text}`,
            );
        }

        return response.json() as Promise<JiraIssueApiResponse>;
    }

    /**
     * Search for issues using a JQL query.
     * Returns raw search results including lightweight field data per issue.
     */
    public async searchIssues(
        baseUrl: string,
        jql: string,
        options?: { maxResults?: number; nextPageToken?: string },
    ): Promise<JiraSearchApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const maxResults = options?.maxResults ?? 100;
        const fields = "summary,status,assignee,priority,issuetype,labels";
        const queryParams = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`;
        const url = options?.nextPageToken
            ? `${apiBase}/search/jql?${queryParams}&nextPageToken=${encodeURIComponent(options.nextPageToken)}`
            : `${apiBase}/search/jql?${queryParams}`;

        logger.debug(`Searching Jira issues via JQL: ${jql}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to run Jira JQL search: ${response.status} ${response.statusText} - ${text}`);
        }

        return response.json() as Promise<JiraSearchApiResponse>;
    }

    /**
     * Convenience helper — returns only the issue keys from a JQL search.
     */
    public async searchIssueKeys(
        baseUrl: string,
        jql: string,
        options?: { maxResults?: number; nextPageToken?: string },
    ): Promise<string[]> {
        const result = await this.searchIssues(baseUrl, jql, options);
        return (result.issues ?? []).map((issue) => issue.key);
    }

    /**
     * Convenience helper — fetches ALL issue keys matching a JQL query by auto-paginating searchIssues().
     */
    public async listAllIssuesByJql(baseUrl: string, jql: string): Promise<string[]> {
        const maxResults = 100;
        const MAX_PAGES = 100;
        const keys: string[] = [];
        let nextPageToken: string | undefined;
        let pages = 0;

        do {
            if (pages++ >= MAX_PAGES) {
                logger.error(
                    `listAllIssuesByJql: exceeded MAX_PAGES (${MAX_PAGES}) for JQL "${jql}". Partial results returned.`,
                );
                break;
            }

            const result = await this.searchIssues(baseUrl, jql, { maxResults, nextPageToken });
            const issues = result.issues || [];
            if (issues.length === 0) {
                break;
            }

            keys.push(...issues.map((issue) => issue.key));
            nextPageToken = result.nextPageToken;
        } while (nextPageToken);

        return keys;
    }

    // --- Project operations ---

    /**
     * List all Jira projects accessible with the current credentials.
     */
    public async listProjects(baseUrl: string): Promise<JiraProjectsApiResponse> {
        const apiBase = this.getApiBase(baseUrl);
        const url = `${apiBase}/project/search`;

        logger.debug(`Fetching Jira projects from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to fetch Jira projects: ${response.status} ${response.statusText} - ${text}`);
        }

        return response.json() as Promise<JiraProjectsApiResponse>;
    }

    // --- Board operations (Jira Software / Agile API) ---

    /**
     * List Jira boards. Optionally filter by project key.
     */
    public async listBoards(baseUrl: string, projectKey?: string): Promise<JiraBoardsApiResponse> {
        const agileBase = baseUrl.trim().replace(/\/$/, "") + "/rest/agile/1.0";
        const projectFilter = projectKey ? `?projectKeyOrId=${encodeURIComponent(projectKey)}` : "";
        const url = `${agileBase}/board${projectFilter}`;

        logger.debug(`Fetching Jira boards from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to fetch Jira boards: ${response.status} ${response.statusText} - ${text}`);
        }

        return response.json() as Promise<JiraBoardsApiResponse>;
    }

    /**
     * Get all issues in a board's backlog.
     */
    public async getBoardBacklogIssues(baseUrl: string, boardId: number): Promise<JiraSearchApiResponse> {
        const agileBase = baseUrl.trim().replace(/\/$/, "") + "/rest/agile/1.0";
        const url = `${agileBase}/board/${boardId}/backlog`;

        logger.debug(`Fetching backlog issues for board ${boardId} from: ${url}`);

        const response = await fetchWithTimeout(url, { headers: await this.getHeaders() });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `Failed to fetch backlog for board ${boardId}: ${response.status} ${response.statusText} - ${text}`,
            );
        }

        return response.json() as Promise<JiraSearchApiResponse>;
    }

    /**
     * Get child issues or sub-tasks of a parent issue (e.g. issues in an Epic, or sub-tasks of a Story/Task).
     */
    public async listChildIssues(
        baseUrl: string,
        parentKey: string,
        options?: { maxResults?: number; nextPageToken?: string },
    ): Promise<JiraSearchApiResponse> {
        if (!/^[A-Z][A-Z0-9]*-\d+$/i.test(parentKey)) {
            throw new Error(`Invalid Jira issue key format: ${parentKey}`);
        }
        const jql = `parent = ${parentKey}`;
        return this.searchIssues(baseUrl, jql, options);
    }
}
