import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { getLogger } from "log4js";
import { basename, dirname, extname, join, relative, resolve, sep } from "path";
import pLimit from "p-limit";
import { Service } from "typedi";
import { z } from "zod";
import { ConfluenceService } from "../../integrations/confluence/services/confluence.service";
import { parseConfluenceUrl } from "../../integrations/confluence/utils/confluence-url.util";
import { JiraService } from "../../integrations/jira/services/jira.service";
import { parseJiraUrl } from "../../integrations/jira/utils/jira-url.util";
import { parseGoogleDocUrl, parseGoogleSheetUrl } from "../../integrations/google-drive/utils/google-drive-url.util";
import { ConfigService } from "../config-service";
import { GoogleDriveService } from "../../integrations/google-drive/services/google-drive.service";
import { S3Service } from "../../integrations/aws/services/s3.service";
import { JiraKnowledgeSource } from "../knowledge/jira-knowledge.source";
import { ConfluenceKnowledgeSource } from "../knowledge/confluence-knowledge.source";
import { GoogleDriveKnowledgeSource } from "../knowledge/google-drive-knowledge.source";
import { GoogleSheetsKnowledgeSource } from "../knowledge/google-sheets-knowledge.source";
import { KnowledgeDocument, KnowledgeSource } from "../knowledge/knowledge-source.model";

const logger = getLogger("OnboardService");

// --- Config Schemas ---
// --- Config Schemas ---
// Centralized in config-service.ts. Re-exported here for backward compatibility.
import {
    OnboardPageSchema,
    OnboardTicketSchema,
    OnboardDocSchema,
    OnboardConfluenceProjectConfig,
    OnboardJiraProjectConfig,
    OnboardGoogleSheetsConfig,
    OnboardSheetLinksConfig,
    OnboardProjectConfig,
    OnboardConfigSchema,
    OnboardConfig,
} from "../config-service";

export {
    OnboardPageSchema,
    OnboardTicketSchema,
    OnboardDocSchema,
    OnboardConfluenceProjectConfig,
    OnboardJiraProjectConfig,
    OnboardGoogleSheetsConfig,
    OnboardSheetLinksConfig,
    OnboardProjectConfig,
    OnboardConfigSchema,
    OnboardConfig,
};

export interface ConfluenceTask {
    pageEntry: z.infer<typeof OnboardPageSchema>;
    projectName?: string;
    baseUrl?: string;
}

export interface JiraTask {
    ticketEntry: z.infer<typeof OnboardTicketSchema>;
    projectName?: string;
    baseUrl?: string;
}

export interface GoogleDocTask {
    docEntry: z.infer<typeof OnboardDocSchema>;
    projectName?: string;
}

// --- Internal mapped task types (after URL parsing) ---

interface MappedTask {
    id: string;
    baseUrl?: string;
    projectName?: string;
    outputPath?: string;
}

@Service()
export class OnboardService {
    constructor(
        // Raw integration services — needed for space/JQL resolution (not covered by KnowledgeSource adapters)
        private readonly confluence: ConfluenceService,
        private readonly jira: JiraService,
        // GoogleDriveService is used for raw batch spreadsheet reads (JSON sidecar + sheet link resolution)
        private readonly googleDrive: GoogleDriveService,
        // KnowledgeSource adapters — own the fetch → normalize → KnowledgeDocument mapping
        private readonly jiraSource: JiraKnowledgeSource,
        private readonly confluenceSource: ConfluenceKnowledgeSource,
        private readonly googleDriveSource: GoogleDriveKnowledgeSource,
        private readonly googleSheetsSource: GoogleSheetsKnowledgeSource,
        private readonly config: ConfigService,
        private readonly s3: S3Service,
    ) {}

    /** When set, overrides every task's project name for the duration of a sync() call. */
    private projectNameOverride?: string;
    /** Absolute paths of every file written during the current sync() call. */
    private syncedFiles: string[] = [];

    public async sync(
        config: OnboardConfig,
        cwd: string,
        projectNameOverride?: string,
    ): Promise<{ filesWritten: string[] }> {
        this.projectNameOverride = projectNameOverride;
        this.syncedFiles = [];

        // Resolve onboarding sheets links
        const globalSheetConfigs = config.onboardingSheets || [];
        const projectSheetConfigs = Object.entries(config.projects || {}).flatMap(
            ([projectName, projectConfig]) =>
                projectConfig.onboardingSheets?.map((sheetConfig) => ({
                    ...sheetConfig,
                    projectName,
                })) || [],
        );
        const allSheetConfigs = [...globalSheetConfigs, ...projectSheetConfigs];
        const sheetResolved =
            allSheetConfigs.length > 0
                ? await this.resolveTasksFromSheets(allSheetConfigs)
                : { confluenceTasks: [], jiraTasks: [], googleTasks: [], sheetTasks: [] };

        // Collect Confluence tasks
        const globalConfluenceTasks =
            config.confluence?.pages?.map((pageEntry) => ({
                pageEntry,
                baseUrl: config.confluence?.baseUrl,
            })) || [];

        const globalSpacePages = await (config.confluence?.spaces || []).reduce(
            async (accPromise, spaceKey) => {
                const acc = await accPromise;
                const targetBaseUrl = config.confluence?.baseUrl;
                if (!targetBaseUrl) {
                    logger.error("No base URL configured for global confluence spaces.");
                    return acc;
                }
                try {
                    logger.info(`Resolving pages for global space: ${spaceKey}...`);
                    const pages = await this.confluence.listAllPagesInSpace(targetBaseUrl, spaceKey);
                    const spaceTasks = pages.map((page) => ({
                        pageEntry: { id: page.id! },
                        projectName: spaceKey,
                        baseUrl: targetBaseUrl,
                    }));
                    return [...acc, ...spaceTasks];
                } catch (err) {
                    logger.error(`Failed to resolve global space ${spaceKey}: ${(err as Error).message}`);
                    return acc;
                }
            },
            Promise.resolve([] as ConfluenceTask[]),
        );

        const projectConfluenceTasks = await Object.entries(config.projects || {}).reduce(
            async (accPromise, [projectName, projectConfig]) => {
                const acc = await accPromise;
                if (!projectConfig.confluence) return acc;
                const confProj = projectConfig.confluence;
                const baseUrl = confProj.baseUrl || config.confluence?.baseUrl;

                const spaceTasks = await (async () => {
                    if (!confProj.space) return [];
                    if (!baseUrl) {
                        logger.error(`No base URL configured for Confluence space in project: ${projectName}`);
                        return [];
                    }
                    try {
                        logger.info(`Resolving pages for project ${projectName} from space ${confProj.space}...`);
                        const pages = await this.confluence.listAllPagesInSpace(baseUrl, confProj.space);
                        return pages.map((page) => ({
                            pageEntry: { id: page.id! },
                            projectName,
                            baseUrl,
                        }));
                    } catch (err) {
                        logger.error(
                            `Failed to resolve space ${confProj.space} for project ${projectName}: ${(err as Error).message}`,
                        );
                        return [];
                    }
                })();

                const pageTasks =
                    confProj.pages?.map((pageEntry) => ({
                        pageEntry,
                        projectName,
                        baseUrl,
                    })) || [];

                return [...acc, ...spaceTasks, ...pageTasks];
            },
            Promise.resolve([] as ConfluenceTask[]),
        );

        const confluenceTasks: ConfluenceTask[] = [
            ...globalConfluenceTasks,
            ...globalSpacePages,
            ...projectConfluenceTasks,
            ...sheetResolved.confluenceTasks,
        ];

        // Collect Jira Tasks
        const globalJiraTasks =
            config.jira?.tickets?.map((ticketEntry) => ({
                ticketEntry,
                baseUrl: config.jira?.baseUrl,
            })) || [];

        const projectJiraTasks = await Object.entries(config.projects || {}).reduce(
            async (accPromise, [projectName, projectConfig]) => {
                const acc = await accPromise;
                if (!projectConfig.jira) return acc;
                const jiraProj = projectConfig.jira;
                const baseUrl = jiraProj.baseUrl || config.jira?.baseUrl;

                const jqlTasks = await (async () => {
                    if (!jiraProj.jql) return [];
                    if (!baseUrl) {
                        logger.error(`No base URL configured for Jira JQL search in project: ${projectName}`);
                        return [];
                    }
                    try {
                        logger.info(`Resolving Jira tickets for project ${projectName} via JQL: ${jiraProj.jql}...`);
                        const ticketKeys = await this.jira.listAllIssuesByJql(baseUrl, jiraProj.jql);
                        return ticketKeys.map((key) => ({
                            ticketEntry: { key },
                            projectName,
                            baseUrl,
                        }));
                    } catch (err) {
                        logger.error(`Failed to run JQL for project ${projectName}: ${(err as Error).message}`);
                        return [];
                    }
                })();

                const ticketTasks =
                    jiraProj.tickets?.map((ticketEntry) => ({
                        ticketEntry,
                        projectName,
                        baseUrl,
                    })) || [];

                return [...acc, ...jqlTasks, ...ticketTasks];
            },
            Promise.resolve([] as JiraTask[]),
        );

        const jiraTasks: JiraTask[] = [...globalJiraTasks, ...projectJiraTasks, ...sheetResolved.jiraTasks];

        // Collect Google Tasks
        const globalGoogleTasks = config.googleDocs?.docs?.map((docEntry) => ({ docEntry })) || [];
        const projectGoogleTasks = Object.entries(config.projects || {}).flatMap(
            ([projectName, projectConfig]) =>
                projectConfig.googleDocs?.docs?.map((docEntry) => ({ docEntry, projectName })) || [],
        );
        const googleTasks: GoogleDocTask[] = [
            ...globalGoogleTasks,
            ...projectGoogleTasks,
            ...sheetResolved.googleTasks,
        ];

        // Run executions
        if (confluenceTasks.length > 0) {
            const mappedTasks = confluenceTasks.map((t) => {
                const isUrl =
                    typeof t.pageEntry === "string" &&
                    (t.pageEntry.startsWith("http://") || t.pageEntry.startsWith("https://"));
                const urlParsed = isUrl ? parseConfluenceUrl(t.pageEntry as string) : null;
                if (isUrl && !urlParsed) {
                    throw new Error(`Could not extract a valid page ID from Confluence URL: ${t.pageEntry}`);
                }
                return {
                    id: urlParsed ? urlParsed.pageId : typeof t.pageEntry === "string" ? t.pageEntry : t.pageEntry.id,
                    baseUrl: urlParsed ? urlParsed.baseUrl : t.baseUrl,
                    projectName: t.projectName,
                    outputPath: typeof t.pageEntry === "string" ? undefined : t.pageEntry.outputPath,
                };
            });
            await this.executeTasks(
                this.confluenceSource,
                mappedTasks,
                cwd,
                "Confluence",
                "confluence",
                "page(s)",
                config.confluence?.baseUrl,
            );
        }

        if (jiraTasks.length > 0) {
            const mappedTasks = jiraTasks.map((t) => {
                const isUrl =
                    typeof t.ticketEntry === "string" &&
                    (t.ticketEntry.startsWith("http://") || t.ticketEntry.startsWith("https://"));
                const urlParsed = isUrl ? parseJiraUrl(t.ticketEntry as string) : null;
                if (isUrl && !urlParsed) {
                    throw new Error(`Could not extract a valid ticket key from Jira URL: ${t.ticketEntry}`);
                }
                return {
                    id: urlParsed
                        ? urlParsed.ticketKey
                        : typeof t.ticketEntry === "string"
                          ? t.ticketEntry
                          : t.ticketEntry.key,
                    baseUrl: urlParsed ? urlParsed.baseUrl : t.baseUrl,
                    projectName: t.projectName,
                    outputPath: typeof t.ticketEntry === "string" ? undefined : t.ticketEntry.outputPath,
                };
            });
            await this.executeTasks(
                this.jiraSource,
                mappedTasks,
                cwd,
                "Jira",
                "jira",
                "ticket(s)",
                config.jira?.baseUrl,
            );
        }

        if (googleTasks.length > 0) {
            const mappedTasks = googleTasks.map((t) => {
                const isUrl =
                    typeof t.docEntry === "string" &&
                    (t.docEntry.startsWith("http://") || t.docEntry.startsWith("https://"));
                const urlParsed = isUrl ? parseGoogleDocUrl(t.docEntry as string) : null;
                if (isUrl && !urlParsed) {
                    throw new Error(`Could not extract a valid document ID from Google Doc URL: ${t.docEntry}`);
                }
                return {
                    id: urlParsed ? urlParsed : typeof t.docEntry === "string" ? t.docEntry : t.docEntry.id,
                    projectName: t.projectName,
                    outputPath: typeof t.docEntry === "string" ? undefined : t.docEntry.outputPath,
                };
            });
            await this.executeTasks(
                this.googleDriveSource,
                mappedTasks,
                cwd,
                "Google Docs",
                "google-docs",
                "document(s)",
            );
        }

        // Google Sheets — read project index sheet if configured
        const globalSheetConfig = config.googleSheets;
        if (globalSheetConfig) {
            await this.executeGoogleSheetsTasks(globalSheetConfig, cwd);
        }

        const projectSheets = Object.entries(config.projects || {}).filter(
            ([_, projectConfig]) => projectConfig.googleSheets,
        );
        for (const [projectName, projectConfig] of projectSheets) {
            if (projectConfig.googleSheets) {
                await this.executeGoogleSheetsTasks(projectConfig.googleSheets, cwd, projectName);
            }
        }

        // Google Sheets dynamically resolved from cell links
        if (sheetResolved.sheetTasks && sheetResolved.sheetTasks.length > 0) {
            for (const t of sheetResolved.sheetTasks) {
                await this.executeGoogleSheetsTasks({ spreadsheetId: t.spreadsheetId }, cwd, t.projectName);
            }
        }

        const sheetsCount =
            (globalSheetConfig ? 1 : 0) + projectSheets.length + (sheetResolved.sheetTasks?.length || 0);

        if (confluenceTasks.length === 0 && jiraTasks.length === 0 && googleTasks.length === 0 && sheetsCount === 0) {
            logger.warn("No Confluence pages, Jira tickets, Google Documents, or Google Sheets configured to fetch.");
        }

        return { filesWritten: [...this.syncedFiles] };
    }

    // --- Generic task executor (replaces executeConfluenceTasks / executeJiraTasks / executeGoogleDocsTasks) ---

    /**
     * Fetches a list of mapped tasks using the provided KnowledgeSource adapter,
     * deduplicates output paths, and writes each document to disk.
     *
     * @param source        - KnowledgeSource adapter (confluence, jira, or google-drive)
     * @param tasks         - List of mapped tasks with id, baseUrl, projectName, outputPath
     * @param cwd           - Working directory for resolving custom outputPath values
     * @param label         - Human-readable label for log messages (e.g. "Confluence")
     * @param subdir        - Subdirectory under the onboarding dir (e.g. "confluence")
     * @param unit          - Plural unit name for log summary (e.g. "page(s)")
     * @param defaultBaseUrl - Fallback base URL when task.baseUrl is not set
     */
    private async executeTasks(
        source: KnowledgeSource,
        tasks: MappedTask[],
        cwd: string,
        label: string,
        subdir: string,
        unit: string,
        defaultBaseUrl?: string,
    ): Promise<void> {
        logger.info(`Found ${tasks.length} ${label} ${unit} to fetch...`);
        const baseOnboardDir = this.resolveBaseOnboardDir();
        const limit = pLimit(5);
        const usedPaths = new Set<string>();

        const results = await Promise.allSettled(
            tasks.map((task) =>
                limit(async () => {
                    const { id, outputPath, projectName, baseUrl } = task;
                    const targetBaseUrl = baseUrl || defaultBaseUrl || "";

                    // Delegate fetch + normalize to the adapter
                    const doc = targetBaseUrl
                        ? await source.fetch(id, { baseUrl: targetBaseUrl })
                        : await source.fetch(id);

                    // Determine output path
                    const safeTitle = this.getSafeTitle(doc.title, id);
                    const sanitizedProj = this.sanitizeProjectName(projectName);
                    const candidatePath = outputPath
                        ? resolve(cwd, outputPath)
                        : sanitizedProj
                          ? join(baseOnboardDir, subdir, sanitizedProj, `${safeTitle}.md`)
                          : join(baseOnboardDir, subdir, `${safeTitle}.md`);

                    const absoluteOutputPath = this.getUniqueOutputPath(candidatePath, usedPaths);
                    usedPaths.add(absoluteOutputPath);

                    await this.writeDoc(doc, absoluteOutputPath);
                    logger.info(`✓ Saved ${label} "${doc.title}" to: ${absoluteOutputPath} (and JSON metadata)`);
                }),
            ),
        );

        this.logResults(results, label, unit);
    }

    // --- Google Sheets dedicated task executor (structured data, not a KnowledgeDocument flow) ---

    private async executeGoogleSheetsTasks(
        sheetConfig: z.infer<typeof OnboardGoogleSheetsConfig>,
        cwd: string,
        projectName?: string,
    ): Promise<void> {
        const { spreadsheetId, range } = sheetConfig;
        const effectiveProjectName = this.projectNameOverride ?? projectName;
        if (effectiveProjectName) {
            logger.info(`Reading Google Sheet ${spreadsheetId} for project "${effectiveProjectName}"...`);
        } else {
            logger.info(`Reading project index sheet ${spreadsheetId}...`);
        }

        const baseOnboardDir = this.resolveBaseOnboardDir();

        try {
            // Delegate fetch to the GoogleSheetsKnowledgeSource adapter
            const doc = await this.googleSheetsSource.fetch(spreadsheetId, { range });
            const spreadsheetTitle = doc.title;

            const safeTitle = this.getSafeTitle(spreadsheetTitle, spreadsheetId);
            const sanitizedProj = this.sanitizeProjectName(projectName);

            const outputDir = sanitizedProj
                ? join(baseOnboardDir, "google-sheets", sanitizedProj)
                : join(baseOnboardDir, "google-sheets");
            const jsonPath = join(outputDir, `${safeTitle}.json`);

            // Fetch raw rows for the JSON sidecar via GoogleDriveService directly
            const spreadsheetMeta = await this.googleDrive.getSpreadsheetMetadata(spreadsheetId);
            const firstSheetTitle = spreadsheetMeta.sheets?.[0]?.title ?? "Sheet1";
            const effectiveRange = range ?? firstSheetTitle;
            const batchData = await this.googleDrive.batchGetSpreadsheetValues(spreadsheetId, [effectiveRange]);
            const allRows = batchData.valueRanges?.[0]?.values ?? [];

            if (allRows.length === 0) {
                logger.warn(`Google Sheet "${spreadsheetTitle}" range "${effectiveRange}" returned no data.`);
                return;
            }

            const sidecar = {
                spreadsheetId,
                title: spreadsheetTitle,
                range: effectiveRange,
                fetchedAt: new Date().toISOString(),
                rowCount: allRows.length,
                headers: allRows[0] ?? [],
                rows: allRows.slice(1),
            };

            await mkdir(outputDir, { recursive: true });
            await writeFile(jsonPath, JSON.stringify(sidecar, null, 4), "utf8");
            this.syncedFiles.push(jsonPath);

            logger.info(
                `✓ Saved Google Sheet "${spreadsheetTitle}" index (${allRows.length - 1} data row(s)) to: ${jsonPath}`,
            );
        } catch (err) {
            logger.error(`✗ Failed to read Google Sheet ${spreadsheetId}: ${(err as Error).message}`);
        }
    }

    // --- Shared persistence helper ---

    /**
     * Writes a KnowledgeDocument to disk:
     *   - <absoluteOutputPath>       — Markdown content
     *   - <absoluteOutputPath>.json  — JSON metadata sidecar (no content field)
     */
    private async writeDoc(doc: KnowledgeDocument, absoluteOutputPath: string): Promise<void> {
        const absoluteJsonPath = absoluteOutputPath.endsWith(".md")
            ? absoluteOutputPath.slice(0, -3) + ".json"
            : absoluteOutputPath + ".json";
        const { content: _content, ...metadataOnly } = doc;

        await mkdir(dirname(absoluteOutputPath), { recursive: true });
        await writeFile(absoluteOutputPath, doc.content, "utf8");
        await writeFile(absoluteJsonPath, JSON.stringify(metadataOnly, null, 4), "utf8");
        this.syncedFiles.push(absoluteOutputPath, absoluteJsonPath);
    }

    // --- S3 upload ---

    private static readonly ONBOARD_SUBDIRS = ["confluence", "jira", "google-docs", "google-sheets"] as const;

    /**
     * Uploads the given local files (absolute paths, e.g. from sync()'s filesWritten) to the
     * configured S3 bucket, mirroring their path relative to the local onboarding directory.
     * For each file: ensures the destination "folder" prefix exists, skips upload if the object
     * is already present in S3, otherwise uploads it.
     */
    public async uploadToS3(filePaths: string[]): Promise<{ uploaded: number; skipped: number; failed: number }> {
        if (filePaths.length === 0) {
            logger.warn("No files were synced in this run — nothing to upload to S3.");
            return { uploaded: 0, skipped: 0, failed: 0 };
        }

        const baseOnboardDir = this.resolveBaseOnboardDir();
        const ensuredPrefixes = new Set<string>();
        let uploaded = 0;
        let skipped = 0;
        let failed = 0;

        for (const filePath of filePaths) {
            const key = relative(baseOnboardDir, filePath).split(sep).join("/");
            try {
                const folderPrefix = dirname(key);
                if (folderPrefix && folderPrefix !== "." && !ensuredPrefixes.has(folderPrefix)) {
                    await this.s3.ensurePrefixExists(folderPrefix);
                    ensuredPrefixes.add(folderPrefix);
                }

                const alreadyExists = await this.s3.objectExists(key);
                if (alreadyExists) {
                    logger.info(`  s3: ${key} already exists — skipping`);
                    skipped++;
                    continue;
                }

                const body = await readFile(filePath);
                const contentType = key.endsWith(".json") ? "application/json" : "text/markdown";
                await this.s3.putObject(key, body, contentType);
                logger.info(`  s3: uploaded ${key}`);
                uploaded++;
            } catch (err) {
                logger.error(`  s3: failed to upload ${key}: ${(err as Error).message}`);
                failed++;
            }
        }

        logger.info(`\nS3 upload completed: ${uploaded} uploaded, ${skipped} already present, ${failed} failed.`);
        return { uploaded, skipped, failed };
    }

    // --- Local listing ---

    /**
     * Lists locally synced onboarding documents, grouped by project name and source category.
     */
    public async listSyncedDocuments(): Promise<void> {
        const baseOnboardDir = this.resolveBaseOnboardDir();
        const grouped: Record<string, Record<string, string[]>> = {};

        for (const subdir of OnboardService.ONBOARD_SUBDIRS) {
            const subdirPath = join(baseOnboardDir, subdir);
            let entries: import("fs").Dirent[];
            try {
                entries = await readdir(subdirPath, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const projectName = entry.name;
                    const docs = await this.describeDocsInDir(join(subdirPath, projectName), subdir);
                    if (docs.length > 0) {
                        (grouped[projectName] ??= {})[subdir] = docs;
                    }
                } else if (entry.isFile() && this.isDocFile(entry.name, subdir)) {
                    const doc = await this.describeDoc(join(subdirPath, entry.name), subdir);
                    if (doc) {
                        (grouped["(no project)"] ??= {})[subdir] ??= [];
                        grouped["(no project)"][subdir].push(doc);
                    }
                }
            }
        }

        const projectNames = Object.keys(grouped).sort();
        if (projectNames.length === 0) {
            logger.info(`No onboarding documents found locally under: ${baseOnboardDir}`);
            logger.info("Run 'sat-cli onboard' first.");
            return;
        }

        for (const projectName of projectNames) {
            logger.info(`\n${projectName}`);
            for (const [category, docs] of Object.entries(grouped[projectName])) {
                logger.info(`  ${category} (${docs.length}):`);
                for (const doc of docs) {
                    logger.info(`    - ${doc}`);
                }
            }
        }
    }

    private isDocFile(fileName: string, subdir: string): boolean {
        if (subdir === "google-sheets") return fileName.endsWith(".json");
        return fileName.endsWith(".md");
    }

    private async describeDocsInDir(dirPath: string, subdir: string): Promise<string[]> {
        let entries: import("fs").Dirent[];
        try {
            entries = await readdir(dirPath, { withFileTypes: true });
        } catch {
            return [];
        }

        const docs: string[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !this.isDocFile(entry.name, subdir)) continue;
            const doc = await this.describeDoc(join(dirPath, entry.name), subdir);
            if (doc) docs.push(doc);
        }
        return docs;
    }

    private async describeDoc(filePath: string, subdir: string): Promise<string | undefined> {
        try {
            if (subdir === "google-sheets") {
                const raw = JSON.parse(await readFile(filePath, "utf8"));
                return `${raw.title ?? basename(filePath)} (${raw.rowCount ?? "?"} rows)`;
            }
            const jsonPath = filePath.replace(/\.md$/, ".json");
            const raw = JSON.parse(await readFile(jsonPath, "utf8"));
            return raw.title ?? basename(filePath);
        } catch {
            return basename(filePath);
        }
    }

    // --- Logging helper ---

    private logResults(results: PromiseSettledResult<void>[], label: string, unit: string): void {
        results.forEach((res) => {
            if (res.status === "rejected") {
                logger.error(`✗ ${label} sync task failed: ${res.reason.message}`);
            }
        });
        const fetchedCount = results.filter((r) => r.status === "fulfilled").length;
        const failedCount = results.filter((r) => r.status === "rejected").length;
        logger.info(`\n${label} sync completed: ${fetchedCount} ${unit} fetched, ${failedCount} failed.`);
    }

    // --- Private utilities ---

    private getSafeTitle(title: string, fallbackId: string): string {
        return (
            title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "") || fallbackId
        );
    }

    private resolveBaseOnboardDir(): string {
        const personalPath = this.config.getPersonalConfigPath();
        return join(dirname(personalPath), "onboarding");
    }

    private sanitizeProjectName(projectName?: string): string | undefined {
        const effective = this.projectNameOverride ?? projectName;
        if (!effective) return undefined;
        return (
            effective
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "") || "default"
        );
    }

    private getUniqueOutputPath(basePath: string, usedPaths: Set<string>): string {
        const getUnique = (pathStr: string, suffix: number): string => {
            if (!usedPaths.has(pathStr)) return pathStr;
            const nextPath = pathStr.endsWith(".md")
                ? pathStr.replace(/(-\d+)?\.md$/, `-${suffix}.md`)
                : (() => {
                      const ext = extname(pathStr);
                      const baseName = pathStr.slice(0, pathStr.length - ext.length);
                      const cleanBaseName = baseName.replace(/(-\d+)?$/, `-${suffix}`);
                      return cleanBaseName + ext;
                  })();
            return getUnique(nextPath, suffix + 1);
        };
        return getUnique(basePath, 2);
    }

    private async resolveTasksFromSheets(
        sheetConfigs: Array<{ spreadsheetId: string; range?: string; projectName?: string }>,
    ): Promise<{
        confluenceTasks: ConfluenceTask[];
        jiraTasks: JiraTask[];
        googleTasks: GoogleDocTask[];
        sheetTasks: Array<{ spreadsheetId: string; projectName?: string }>;
    }> {
        const results = await Promise.all(
            sheetConfigs.map(async (sheetConfig) => {
                const { spreadsheetId, range, projectName } = sheetConfig;
                try {
                    const spreadsheet = await this.googleDrive.getSpreadsheetMetadata(spreadsheetId);

                    // Determine which tabs to read
                    const rangesToFetch = range
                        ? [range]
                        : (spreadsheet.sheets || []).map((s) => s.title).filter((t): t is string => !!t);

                    if (rangesToFetch.length === 0) {
                        rangesToFetch.push("Sheet1");
                    }

                    // Fetch values for all target ranges in a single batch call
                    const batchData = await this.googleDrive.batchGetSpreadsheetValues(spreadsheetId, rangesToFetch);
                    const valueRanges = batchData.valueRanges || [];

                    const confluenceTasks: ConfluenceTask[] = [];
                    const jiraTasks: JiraTask[] = [];
                    const googleTasks: GoogleDocTask[] = [];
                    const sheetTasks: Array<{ spreadsheetId: string; projectName?: string }> = [];

                    valueRanges.forEach((vr) => {
                        // Extract tab title from range property (e.g. "Sheet1!A1:Z100" -> "Sheet1")
                        const tabTitle = vr.range?.split("!")[0]?.replace(/^'|'$/g, "") || "Sheet1";
                        // If configured with a global project name, use it; otherwise use the tab title as the project name
                        const resolvedProjectName = projectName ?? tabTitle;

                        const allRows = vr.values || [];
                        allRows.forEach((row) => {
                            row.forEach((cell) => {
                                if (
                                    typeof cell === "string" &&
                                    (cell.startsWith("http://") || cell.startsWith("https://"))
                                ) {
                                    const trimCell = cell.trim();
                                    const confUrl = parseConfluenceUrl(trimCell);
                                    if (confUrl) {
                                        confluenceTasks.push({
                                            pageEntry: { id: confUrl.pageId },
                                            projectName: resolvedProjectName,
                                            baseUrl: confUrl.baseUrl,
                                        });
                                        return;
                                    }
                                    const jiraUrl = parseJiraUrl(trimCell);
                                    if (jiraUrl) {
                                        jiraTasks.push({
                                            ticketEntry: { key: jiraUrl.ticketKey },
                                            projectName: resolvedProjectName,
                                            baseUrl: jiraUrl.baseUrl,
                                        });
                                        return;
                                    }
                                    const docUrl = parseGoogleDocUrl(trimCell);
                                    if (docUrl) {
                                        googleTasks.push({
                                            docEntry: { id: docUrl },
                                            projectName: resolvedProjectName,
                                        });
                                        return;
                                    }
                                    const sheetUrl = parseGoogleSheetUrl(trimCell);
                                    if (sheetUrl) {
                                        sheetTasks.push({
                                            spreadsheetId: sheetUrl,
                                            projectName: resolvedProjectName,
                                        });
                                        return;
                                    }
                                }
                            });
                        });
                    });

                    return { confluenceTasks, jiraTasks, googleTasks, sheetTasks };
                } catch (err) {
                    logger.error(`Failed to read onboarding Google Sheet ${spreadsheetId}: ${(err as Error).message}`);
                    return { confluenceTasks: [], jiraTasks: [], googleTasks: [], sheetTasks: [] };
                }
            }),
        );

        return results.reduce(
            (acc, curr) => ({
                confluenceTasks: [...acc.confluenceTasks, ...curr.confluenceTasks],
                jiraTasks: [...acc.jiraTasks, ...curr.jiraTasks],
                googleTasks: [...acc.googleTasks, ...curr.googleTasks],
                sheetTasks: [...acc.sheetTasks, ...curr.sheetTasks],
            }),
            { confluenceTasks: [], jiraTasks: [], googleTasks: [], sheetTasks: [] },
        );
    }
}
