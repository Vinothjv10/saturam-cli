import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import {
    BedrockKnowledgeBaseService,
    RetrievedChunk,
} from "../../../integrations/aws/services/bedrock-knowledge-base.service";
import { ChatTurn } from "../chat-session.model";
import { CodeIndexService, RepoIndex } from "../code-index.service";
import { DocumentReaderService } from "../document-reader.service";
import { CODE_CATEGORY, DOCUMENT_KINDS, isDocumentKind, retrievalFiltersFor } from "../knowledge-source.model";
import { ProjectRegistryService, RegistryProject, RegistryRepo, repoFullName } from "../project-registry.service";

const logger = getLogger("KnowledgeTools");

/** Chunks returned per search. One number, because the agent decides how many searches to run. */
const SEARCH_RESULT_COUNT = 12;

/**
 * Whole documents read per question. A plan that needs more than this has lost its way; a
 * question that needs one or two is the common case this exists for.
 */
export const MAX_READS_PER_QUESTION = 6;

/**
 * The tools the mentor agent can call.
 *
 * This is the whole extension surface. Everything the old flow expressed as an intent branch —
 * "which project is this about", "plan four searches", "is this a question about the corpus
 * itself", "what did we discuss" — is now the agent choosing which of these to call and with
 * what arguments. Adding a capability means adding a tool here, not a branch, a constant and a
 * prompt paragraph somewhere else.
 *
 * The corpus holds two kinds of material since source code was indexed beside the documents:
 * prose that explains, and code that runs. Search covers both and can be narrowed to either;
 * reading and browsing exist because a search result is a slice, and a slice of code is rarely
 * enough to explain what the code does.
 */
export const KNOWLEDGE_TOOL_DEFINITIONS = [
    {
        name: "search_documentation",
        description:
            "Search the indexed internal documentation and source code and return the most relevant passages. " +
            "Call this before answering anything about our systems, and call it again with different " +
            'wording when the first results miss the subject. `kind` chooses what to search: "docs" for ' +
            'written material (wiki pages, tickets, design documents), "code" for source files indexed from ' +
            'the repositories, "all" (the default) for both. Omit `project` for a broad search across ' +
            "everything (useful when you do not yet know which project the question belongs to, or when " +
            "the question spans several); pass it to narrow to one project once you do. `repo` narrows code " +
            "results to one repository, as workspace/repo-slug. Each result carries its project, title and " +
            "source, so a broad search is also how you find out which project a question is about, and a " +
            "`document:` id that read_document accepts.",
        schema: z.object({
            query: z
                .string()
                .describe("What to look for, phrased the way a document would state it rather than as a question."),
            project: z
                .string()
                .optional()
                .describe("Project slug to restrict the search to. Omit to search across all projects."),
            kind: z
                .enum(["docs", "code", "all"])
                .optional()
                .describe('"docs" for written documentation, "code" for source files, "all" (default) for both.'),
            repo: z
                .string()
                .optional()
                .describe('Restrict code results to one repository, as workspace/repo-slug. Implies kind "code".'),
        }),
    },
    {
        name: "read_document",
        description:
            "Read a whole document or source file from the corpus, when a search result is a slice of " +
            "something you need to see in full — the rest of a function, the sections around a passage, a " +
            "file a listing named. Pass the `document:` id a search result gave you, or `workspace/repo:path` " +
            "for a file a repository listing showed. A source file comes back with its own line numbers; use " +
            "startLine and endLine to read part of a long one, and call again when the reply says more remains. " +
            "There is a budget of a few reads per question, so read what you will actually use.",
        schema: z.object({
            document: z
                .string()
                .describe("The `document:` id from a search result, or workspace/repo:path from a repository listing."),
            startLine: z.number().int().positive().optional().describe("First line to return (1-based)."),
            endLine: z.number().int().positive().optional().describe("Last line to return (inclusive)."),
        }),
    },
    {
        name: "browse_repository",
        description:
            "List what a project's source repositories contain, from the index. Call it with only the " +
            "project to see its repositories; then with `repo` and a `directory` to see one directory's " +
            "files and sub-directories. Use it when a question asks where something lives, what a module " +
            "is made of, or names a directory. Every path it returns is real and can be read with " +
            "read_document as workspace/repo:path.",
        schema: z.object({
            project: z.string().describe("Project slug, as list_projects or a search result shows it."),
            repo: z
                .string()
                .optional()
                .describe(
                    "Which repository, as workspace/repo-slug or just the slug. Omit to list the project's repositories.",
                ),
            directory: z
                .string()
                .optional()
                .describe('Directory to list, relative to the repository root, such as "src/jobs". Omit for the root.'),
        }),
    },
    {
        name: "list_projects",
        description:
            "List the projects that are indexed, with their slugs, document counts, repositories and summaries. " +
            "Call this to answer what you can help with, to find the exact slug for a project the user " +
            "named, or to check whether a subject is covered at all before saying it is not.",
        schema: z.object({}),
    },
    {
        name: "recall_conversation",
        description:
            "Return the earlier turns of this conversation, including ones from previous sessions that " +
            "are no longer in your immediate context. Call this when the user asks what was discussed, " +
            "what they asked before, or to be reminded of something from earlier.",
        schema: z.object({}),
    },
] as const;

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
    const value = args[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lineArg(args: Record<string, unknown>, name: string): number | undefined {
    const value = args[name];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function metadataString(chunk: RetrievedChunk, field: string): string | undefined {
    const value = chunk.metadata?.[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Runs the tools and keeps whatever they retrieved.
 *
 * One executor per question. The chunks accumulate across every search the agent ran, because
 * the callers downstream — the source list, the unsupported-identifier check, the follow-up
 * generator — all need the evidence the answer was actually built from, not just the last search.
 * So do the names: every path a listing returned and every document that was read is something
 * the agent genuinely saw, and the identifier guard must not take it back as an invention.
 */
export class KnowledgeToolExecutor {
    private readonly seen = new Map<string, RetrievedChunk>();
    private readonly known = new Set<string>();
    private searches = 0;
    private reads = 0;

    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly reader: DocumentReaderService,
        private readonly codeIndex: CodeIndexService,
        private readonly history: ChatTurn[],
    ) {}

    /** Every chunk any search returned this turn, newest search last, de-duplicated. */
    public get chunks(): RetrievedChunk[] {
        return [...this.seen.values()];
    }

    public get searchCount(): number {
        return this.searches;
    }

    public get readCount(): number {
        return this.reads;
    }

    /** Names established by a listing, a read, or a result's metadata, rather than by a passage's text. */
    public get knownIdentifiers(): string[] {
        return [...this.known];
    }

    public async run(call: ToolCall): Promise<string> {
        switch (call.name) {
            case "search_documentation":
                return this.search(call.args);
            case "read_document":
                return this.readDocument(call.args);
            case "browse_repository":
                return this.browse(call.args);
            case "list_projects":
                return this.listProjects();
            case "recall_conversation":
                return this.recall();
            default:
                // Returned rather than thrown: a model that invents a tool name should be told so
                // and given another turn, not have the question fail.
                return `There is no tool called "${call.name}". Available tools: ${KNOWLEDGE_TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`;
        }
    }

    private async search(args: Record<string, unknown>): Promise<string> {
        const query = stringArg(args, "query");
        if (!query) return "The `query` argument is required and must be a non-empty string.";
        const project = stringArg(args, "project");
        const repo = stringArg(args, "repo");
        const kindArg = stringArg(args, "kind");
        if (kindArg !== undefined && !isDocumentKind(kindArg)) {
            return `\`kind\` must be one of ${DOCUMENT_KINDS.map((k) => `"${k}"`).join(", ")}.`;
        }
        const kind = kindArg !== undefined && isDocumentKind(kindArg) ? kindArg : undefined;

        this.searches += 1;
        let results: RetrievedChunk[];
        try {
            results = await this.knowledgeBase.retrieve(query, {
                numberOfResults: SEARCH_RESULT_COUNT,
                ...retrievalFiltersFor({ project, kind, repo }),
            });
        } catch (err) {
            // The agent is told what went wrong so it can decide — retry, search differently, or
            // tell the user the corpus is unreachable. That decision is not the executor's.
            logger.warn(`Retrieval failed for "${query}": ${(err as Error).message}`);
            return `The search failed: ${(err as Error).message}. The knowledge base may be unreachable.`;
        }

        if (results.length === 0) {
            const scope = [
                project ? `project "${project}"` : "",
                repo ? `repository "${repo}"` : kind && kind !== "all" ? `kind "${kind}"` : "",
            ]
                .filter(Boolean)
                .join(" and ");
            return scope
                ? `No passages matched "${query}" within ${scope}. Try different wording, or search without that restriction.`
                : `No passages matched "${query}" anywhere in the indexed documentation. Try different wording.`;
        }

        for (const chunk of results) {
            this.seen.set(this.keyOf(chunk), chunk);
            for (const field of ["title", "path", "repo"]) {
                const value = metadataString(chunk, field);
                if (value) this.known.add(value);
            }
        }

        logger.debug(
            `search_documentation("${query}"${project ? `, project=${project}` : ""}${kind ? `, kind=${kind}` : ""}${repo ? `, repo=${repo}` : ""}) → ${results.length}`,
        );

        const rendered = await Promise.all(
            results.map(async (chunk, index) => {
                const label = [
                    metadataString(chunk, "project"),
                    metadataString(chunk, "title"),
                    this.sourceLabel(chunk),
                ]
                    .filter((value): value is string => Boolean(value))
                    .join(" · ");
                const id = await this.reader.documentIdOf(chunk.location);
                const idLine = id ? `\ndocument: ${id}` : "";
                return `[${index + 1}]${label ? ` ${label}` : ""}${idLine}\n${chunk.content.trim()}`;
            }),
        );
        return rendered.join("\n\n---\n\n");
    }

    /** "code · workspace/repo:path" for a source file; the source category for anything else. */
    private sourceLabel(chunk: RetrievedChunk): string | undefined {
        const source = metadataString(chunk, "source");
        if (metadataString(chunk, "category") !== CODE_CATEGORY) return source;
        const repo = metadataString(chunk, "repo");
        const path = metadataString(chunk, "path");
        if (repo && path) return `code · ${repo}:${path}`;
        return repo ? `code · ${repo}` : "code";
    }

    /**
     * Content, not location: a document arrives as several chunks under one S3 URI, so keying on
     * the URI alone would collapse a whole document into its first chunk.
     */
    private keyOf(chunk: RetrievedChunk): string {
        return `${chunk.location ?? ""}::${chunk.content.trim().slice(0, 200)}`;
    }

    private async readDocument(args: Record<string, unknown>): Promise<string> {
        const reference = stringArg(args, "document");
        if (!reference)
            return "The `document` argument is required: the `document:` id from a search result, or workspace/repo:path.";
        if (this.reads >= MAX_READS_PER_QUESTION) {
            return `The read budget for this question (${MAX_READS_PER_QUESTION} documents) is used up. Answer from what you have read, or search for a more specific passage.`;
        }

        this.reads += 1;
        try {
            const slice = await this.reader.read(reference, {
                startLine: lineArg(args, "startLine"),
                endLine: lineArg(args, "endLine"),
            });
            for (const identifier of slice.identifiers) this.known.add(identifier);
            logger.debug(`read_document(${reference}) → ${slice.key}`);
            return slice.content;
        } catch (err) {
            logger.debug(`read_document(${reference}) failed: ${(err as Error).message}`);
            return `Could not read "${reference}": ${(err as Error).message}`;
        }
    }

    private async browse(args: Record<string, unknown>): Promise<string> {
        const project = stringArg(args, "project");
        if (!project) return "The `project` argument is required: the project's slug, as list_projects shows it.";
        const repoRef = stringArg(args, "repo");
        const directory = stringArg(args, "directory") ?? "";

        let index: RepoIndex | undefined;
        try {
            if (repoRef) {
                index = await this.codeIndex.find(project, repoRef);
                if (!index) {
                    const repos = await this.codeIndex.repositories(project);
                    return repos.length === 0
                        ? `No source repositories are indexed for project "${project}".`
                        : `Project "${project}" has no repository called "${repoRef}". Its repositories: ${repos.map(repoFullName).join(", ")}.`;
                }
            } else {
                const repos = await this.codeIndex.repositories(project);
                if (repos.length === 0) return `No source repositories are indexed for project "${project}".`;
                if (repos.length > 1 || !directory) {
                    for (const repo of repos) this.known.add(repoFullName(repo));
                    return this.renderRepositories(project, repos);
                }
                index = await this.codeIndex.find(project, repos[0].folder);
                if (!index) return `No source repositories are indexed for project "${project}".`;
            }
        } catch (err) {
            logger.debug(`browse_repository(${project}) failed: ${(err as Error).message}`);
            return `Could not read the code index for "${project}": ${(err as Error).message}`;
        }

        const listing = this.codeIndex.listDirectory(index, directory);
        this.known.add(index.fullName);
        for (const file of listing.files) this.known.add(listing.directory ? `${listing.directory}/${file}` : file);
        for (const dir of listing.subdirectories)
            this.known.add(listing.directory ? `${listing.directory}/${dir.name}` : dir.name);

        if (listing.subdirectories.length === 0 && listing.files.length === 0) {
            return `${index.fullName} has no indexed files under "${listing.directory || "/"}". Browse the root to see what it holds.`;
        }

        const where = listing.directory ? `${index.fullName}/${listing.directory}/` : `${index.fullName}/ (root)`;
        const lines = [
            `${where} — branch ${index.branch}, commit ${index.commit.slice(0, 12)}${index.complete ? "" : " (last sync incomplete)"}`,
            ...listing.subdirectories.map((dir) => `  ${dir.name}/  (${dir.files} file(s))`),
            ...listing.files.map((file) => `  ${file}`),
        ];
        if (listing.omitted > 0)
            lines.push(`  … ${listing.omitted} more entries not shown; list a sub-directory to narrow.`);
        lines.push(`Read a file with read_document("${index.fullName}:<path>").`);
        return lines.join("\n");
    }

    private renderRepositories(project: string, repos: RegistryRepo[]): string {
        const lines = repos.map((repo) => {
            const count = repo.documentCount !== undefined ? `, ${repo.documentCount} file(s)` : "";
            const branch = repo.branch ? ` @ ${repo.branch}` : "";
            const incomplete = repo.complete === false ? ", last sync incomplete" : "";
            return `- ${repoFullName(repo)}${branch}${count}${incomplete}`;
        });
        return `Repositories indexed for project "${project}":\n${lines.join("\n")}\nCall browse_repository again with \`repo\` to list one.`;
    }

    private async listProjects(): Promise<string> {
        const { projects } = await this.registry.load();
        if (projects.length === 0) {
            return "No projects are indexed. Only general engineering questions can be answered right now.";
        }
        return projects.map((project) => this.renderProject(project)).join("\n");
    }

    private renderProject(project: RegistryProject): string {
        const count = project.documentCount !== undefined ? `, ${project.documentCount} document(s)` : "";
        const aliases = project.aliases.length > 0 ? `, also called: ${project.aliases.join(", ")}` : "";
        const summary = project.summary ? ` — ${project.summary}` : "";
        const breakdown = project.counts
            ? ` (${Object.entries(project.counts)
                  .map(([category, n]) => `${n} ${category === CODE_CATEGORY ? "code" : category}`)
                  .join(", ")})`
            : "";
        const repos =
            project.repos && project.repos.length > 0
                ? `\n  repositories: ${project.repos
                      .map((repo) => {
                          this.known.add(repoFullName(repo));
                          return `${repoFullName(repo)}${repo.branch ? ` @ ${repo.branch}` : ""}`;
                      })
                      .join(", ")}`
                : "";
        return `- ${project.displayName} [slug: ${project.slug}${count}${breakdown}${aliases}]${summary}${repos}`;
    }

    private async recall(): Promise<string> {
        if (this.history.length === 0) {
            return "Nothing has been asked yet — this is the first question in this conversation.";
        }
        return this.history
            .map((turn) => {
                const project = turn.resolvedProject ? ` [${turn.resolvedProject}]` : "";
                return `- Asked: "${turn.question}"${project}\n  You answered: ${turn.answerGist}`;
            })
            .join("\n");
    }
}

/** Builds an executor bound to this question's conversation history. */
@Service()
export class KnowledgeToolFactory {
    constructor(
        private readonly knowledgeBase: BedrockKnowledgeBaseService,
        private readonly registry: ProjectRegistryService,
        private readonly reader: DocumentReaderService,
        private readonly codeIndex: CodeIndexService,
    ) {}

    public create(history: ChatTurn[]): KnowledgeToolExecutor {
        return new KnowledgeToolExecutor(this.knowledgeBase, this.registry, this.reader, this.codeIndex, history);
    }
}
