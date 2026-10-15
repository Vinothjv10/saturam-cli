import { getLogger } from "log4js";
import { Service } from "typedi";
import { z } from "zod";
import { S3Service } from "../../integrations/aws/services/s3.service";
import { CODE_CATEGORY } from "./knowledge-source.model";
import { ProjectRegistryService, RegistryRepo, repoFullName } from "./project-registry.service";

const logger = getLogger("CodeIndex");

/**
 * Where the pipeline records what it indexed from each repository: one JSON object per
 * repository at `<state prefix>/code-index/<project>/<folder>.json`. Under the state prefix, so
 * Bedrock never sees it, which is also why the agent cannot search it and needs this instead.
 */
export const CODE_INDEX_STATE_PREFIX = "code-index/";

/**
 * Beside the state file, `<folder>.symbols.json`: every definition the pipeline's parser found in
 * the repository, and every file that refers to one of those names. Written by the same pipeline
 * after the documents, from the documents, so it describes exactly what is indexed.
 */
export const SYMBOL_INDEX_SUFFIX = ".symbols.json";

/** Entries shown per directory listing; a flat directory of thousands of files is summarised past this. */
export const MAX_LISTED_ENTRIES = 200;

/** Definitions returned per lookup. A name matching more than this needs a narrower name or a repository. */
export const MAX_SYMBOL_MATCHES = 25;

/** Files listed per reference lookup, after which the agent is told how many more there are. */
export const MAX_REFERENCE_FILES = 40;

/** How long a loaded state file is trusted, the same horizon the registry uses and for the same process. */
export const CODE_INDEX_CACHE_TTL_MS = 10 * 60 * 1000;

const RepoStateSchema = z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    branch: z.string(),
    commit: z.string(),
    commitDate: z.string().optional(),
    indexedAt: z.string().optional(),
    version: z.number().optional(),
    planned: z.number().optional(),
    complete: z.boolean().optional(),
    keys: z.array(z.string()),
});

const CodeSymbolSchema = z.object({
    name: z.string(),
    /** function, method, class, constant, variable, interface, type, enum, table, view, resource, key, … */
    kind: z.string(),
    path: z.string(),
    line: z.number(),
    endLine: z.number().optional(),
    signature: z.string().optional(),
    doc: z.string().optional(),
    /** The enclosing class or module-level owner, for a method or a nested definition. */
    parent: z.string().optional(),
});

const SymbolIndexSchema = z.object({
    version: z.number().optional(),
    commit: z.string().optional(),
    builtAt: z.string().optional(),
    files: z.number().optional(),
    parsed: z.number().optional(),
    symbols: z.array(CodeSymbolSchema).default([]),
    /** Files that use a name defined in this repository, with the lines where they do. */
    references: z.array(z.object({ name: z.string(), path: z.string(), lines: z.array(z.number()) })).default([]),
    /** What each file imports: module paths as written, so "who imports this module" is answerable. */
    imports: z.array(z.object({ path: z.string(), modules: z.array(z.string()) })).default([]),
});

export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;
export type SymbolIndex = z.infer<typeof SymbolIndexSchema>;

export interface RepoIndex {
    projectSlug: string;
    folder: string;
    workspace: string;
    repoSlug: string;
    fullName: string;
    branch: string;
    commit: string;
    indexedAt?: string;
    complete: boolean;
    /** Every indexed source path, relative to the repository root, sorted. */
    paths: string[];
}

export interface DirectoryListing {
    /** The directory listed, "" for the root. */
    directory: string;
    subdirectories: Array<{ name: string; files: number }>;
    files: string[];
    /** How many entries were left out past MAX_LISTED_ENTRIES. */
    omitted: number;
}

export interface SymbolMatch extends CodeSymbol {
    projectSlug: string;
    /** `workspace/repo-slug`. */
    repo: string;
}

export interface ReferenceHit {
    projectSlug: string;
    repo: string;
    path: string;
    lines: number[];
}

export interface ImportHit {
    projectSlug: string;
    repo: string;
    path: string;
    module: string;
}

export interface SymbolLookup {
    matches: SymbolMatch[];
    /** Matches before the cap, so the agent knows when it saw a sample. */
    total: number;
    /** Repositories whose symbol index was consulted. */
    searched: string[];
    /** Repositories in scope that have no symbol index yet. */
    unindexed: string[];
}

export interface ReferenceLookup {
    definitions: SymbolMatch[];
    references: ReferenceHit[];
    importers: ImportHit[];
    /** Referencing files before the cap. */
    totalFiles: number;
    searched: string[];
    unindexed: string[];
}

export interface LookupScope {
    project?: string;
    repo?: string;
}

/**
 * Reads the pipeline's per-repository index so the agent can see a repository as a tree, and its
 * symbol index so the agent can find a definition and everything that uses it.
 *
 * Retrieval answers "which passages resemble this question"; it cannot answer "what is in this
 * directory", "where is this function defined" or "who calls it", and an agent that cannot ask
 * those questions guesses at paths and misses impact. The pipeline already records every key it
 * wrote for a repository and, since the symbol pass, every definition and use in it, so each of
 * these costs one small object read, and every path they yield is one the agent can go on to read.
 */
@Service()
export class CodeIndexService {
    private readonly cache = new Map<string, { index: RepoIndex; loadedAt: number }>();
    private readonly symbolCache = new Map<string, { index: SymbolIndex | undefined; loadedAt: number }>();

    constructor(
        private readonly s3: S3Service,
        private readonly registry: ProjectRegistryService,
    ) {}

    /**
     * The repositories indexed for a project. The registry lists them from v2 on; before that,
     * the state prefix is listed directly, which costs a ListObjects call and needs that
     * permission, so it is the fallback rather than the rule.
     */
    public async repositories(projectSlug: string): Promise<RegistryRepo[]> {
        const listed = await this.registry.reposOf(projectSlug);
        if (listed.length > 0) return listed;

        try {
            const keys = await this.s3.listStateObjects(`${CODE_INDEX_STATE_PREFIX}${projectSlug}`);
            const folders = keys
                .map((key) => /\/([^/]+)\.json$/.exec(key)?.[1])
                .filter((folder): folder is string => typeof folder === "string" && !folder.endsWith(".symbols"));
            const repos: RegistryRepo[] = [];
            for (const folder of folders) {
                const index = await this.load(projectSlug, folder);
                if (index) {
                    repos.push({
                        workspace: index.workspace,
                        repoSlug: index.repoSlug,
                        folder,
                        branch: index.branch,
                        commit: index.commit,
                        documentCount: index.paths.length,
                        indexedAt: index.indexedAt,
                        complete: index.complete,
                    });
                }
            }
            return repos;
        } catch (err) {
            logger.debug(`Could not list the code index for ${projectSlug}: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Finds one repository of a project by any name a person or the agent would use for it:
     * its folder, its slug, or `workspace/slug`. Undefined when none matches.
     */
    public async find(projectSlug: string, repoRef: string): Promise<RepoIndex | undefined> {
        const wanted = repoRef.trim().toLowerCase();
        if (!wanted) return undefined;
        const repos = await this.repositories(projectSlug);
        const match = repos.find((repo) => CodeIndexService.namesOf(repo).includes(wanted));
        if (match) return this.load(projectSlug, match.folder);
        // A registry that predates repository listing has no folders to match; the folder name is the slug.
        return repos.length === 0
            ? this.load(projectSlug, wanted.includes("/") ? wanted.split("/")[1] : wanted)
            : undefined;
    }

    private static namesOf(repo: RegistryRepo): string[] {
        return [repo.folder, repo.repoSlug, repoFullName(repo)].map((name) => name.toLowerCase());
    }

    /** The index of one repository, by the folder its documents live under; undefined when there is none. */
    public async load(projectSlug: string, folder: string, now: number = Date.now()): Promise<RepoIndex | undefined> {
        const cacheKey = `${projectSlug}/${folder}`;
        const cached = this.cache.get(cacheKey);
        if (cached && now - cached.loadedAt < CODE_INDEX_CACHE_TTL_MS) return cached.index;

        let state: z.infer<typeof RepoStateSchema>;
        try {
            const body = await this.s3.getStateObject(`${CODE_INDEX_STATE_PREFIX}${projectSlug}/${folder}.json`);
            state = RepoStateSchema.parse(JSON.parse(body.toString("utf8")));
        } catch (err) {
            logger.debug(`No code index for ${cacheKey}: ${(err as Error).message}`);
            return undefined;
        }

        const documentPrefix = `${projectSlug}/${CODE_CATEGORY}/${folder}/`;
        const paths = state.keys
            .filter((key) => key.startsWith(documentPrefix))
            .map((key) => key.slice(documentPrefix.length).replace(/\.md$/, ""))
            // The repository index document is the pipeline's, not a file of the repository.
            .filter((path) => path && !path.startsWith("_"))
            .sort();

        const index: RepoIndex = {
            projectSlug,
            folder,
            workspace: state.workspace,
            repoSlug: state.repoSlug,
            fullName: `${state.workspace}/${state.repoSlug}`,
            branch: state.branch,
            commit: state.commit,
            indexedAt: state.indexedAt,
            complete: state.complete ?? true,
            paths,
        };
        this.cache.set(cacheKey, { index, loadedAt: now });
        return index;
    }

    /** One level of the tree: the files directly in `directory` and the sub-directories under it, with their file counts. */
    public listDirectory(index: RepoIndex, directory = ""): DirectoryListing {
        const normalized = directory
            .trim()
            .replace(/^\.?\/+/, "")
            .replace(/\/+$/, "");
        const prefix = normalized ? `${normalized}/` : "";

        const files: string[] = [];
        const subdirectories = new Map<string, number>();
        for (const path of index.paths) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length);
            const slash = rest.indexOf("/");
            if (slash < 0) files.push(rest);
            else {
                const name = rest.slice(0, slash);
                subdirectories.set(name, (subdirectories.get(name) ?? 0) + 1);
            }
        }

        const dirs = [...subdirectories.entries()].map(([name, count]) => ({ name, files: count }));
        const total = dirs.length + files.length;
        const room = Math.max(0, MAX_LISTED_ENTRIES - dirs.length);
        return {
            directory: normalized,
            subdirectories: dirs.slice(0, MAX_LISTED_ENTRIES),
            files: files.slice(0, room),
            omitted: Math.max(0, total - MAX_LISTED_ENTRIES),
        };
    }

    /** The symbol index of one repository, or undefined when the pipeline has not written one yet. */
    public async loadSymbols(
        projectSlug: string,
        folder: string,
        now: number = Date.now(),
    ): Promise<SymbolIndex | undefined> {
        const cacheKey = `${projectSlug}/${folder}`;
        const cached = this.symbolCache.get(cacheKey);
        if (cached && now - cached.loadedAt < CODE_INDEX_CACHE_TTL_MS) return cached.index;

        let index: SymbolIndex | undefined;
        try {
            const body = await this.s3.getStateObject(`${CODE_INDEX_STATE_PREFIX}${cacheKey}${SYMBOL_INDEX_SUFFIX}`);
            index = SymbolIndexSchema.parse(JSON.parse(body.toString("utf8")));
        } catch (err) {
            logger.debug(`No symbol index for ${cacheKey}: ${(err as Error).message}`);
        }
        this.symbolCache.set(cacheKey, { index, loadedAt: now });
        return index;
    }

    /**
     * Where a name is defined, across the repositories in scope. An exact match ranks first, then
     * the same name in another case, then names that begin or end with it, then names that merely
     * contain it; `Class.method` asks for a method of that class.
     */
    public async findSymbols(name: string, scope: LookupScope = {}): Promise<SymbolLookup> {
        const query = name.trim().replace(/\(\)$/, "");
        const dot = query.lastIndexOf(".");
        const parent = dot > 0 ? query.slice(0, dot).toLowerCase() : undefined;
        const bare = dot > 0 ? query.slice(dot + 1) : query;
        const lower = bare.toLowerCase();

        const scored: Array<{ score: number; match: SymbolMatch }> = [];
        const { searched, unindexed } = await this.forEachIndex(scope, (projectSlug, repo, index) => {
            for (const symbol of index.symbols) {
                let score = 0;
                if (symbol.name === bare) score = 4;
                else if (symbol.name.toLowerCase() === lower) score = 3;
                else if (
                    lower.length >= 3 &&
                    (symbol.name.toLowerCase().startsWith(lower) || symbol.name.toLowerCase().endsWith(lower))
                )
                    score = 2;
                else if (lower.length >= 4 && symbol.name.toLowerCase().includes(lower)) score = 1;
                if (score === 0) continue;
                if (parent) {
                    const owner = (symbol.parent ?? "").toLowerCase();
                    if (owner === parent) score += 1;
                    else if (owner && !owner.endsWith(parent)) score -= 1;
                }
                if (score > 0) scored.push({ score, match: { ...symbol, projectSlug, repo } });
            }
        });

        scored.sort(
            (a, b) => b.score - a.score || a.match.path.localeCompare(b.match.path) || a.match.line - b.match.line,
        );
        return {
            matches: scored.slice(0, MAX_SYMBOL_MATCHES).map((entry) => entry.match),
            total: scored.length,
            searched,
            unindexed,
        };
    }

    /**
     * Everything that uses a name: its definitions, the files that refer to it with the lines
     * where they do, and the files that import a module called that. Exact name only — a
     * reference lookup is a question about one thing, and fuzziness here would list the uses of
     * something else as if they were impact.
     */
    public async findReferences(name: string, scope: LookupScope = {}): Promise<ReferenceLookup> {
        const query = name.trim().replace(/\(\)$/, "");
        const bare = query.split(".").pop() ?? query;
        const moduleName = CodeIndexService.moduleBasename(query);

        const definitions: SymbolMatch[] = [];
        const references: ReferenceHit[] = [];
        const importers: ImportHit[] = [];
        const { searched, unindexed } = await this.forEachIndex(scope, (projectSlug, repo, index) => {
            for (const symbol of index.symbols) {
                if (symbol.name === bare) definitions.push({ ...symbol, projectSlug, repo });
            }
            for (const reference of index.references) {
                if (reference.name === bare)
                    references.push({ projectSlug, repo, path: reference.path, lines: reference.lines });
            }
            for (const entry of index.imports) {
                for (const module of entry.modules) {
                    if (CodeIndexService.moduleBasename(module) === moduleName) {
                        importers.push({ projectSlug, repo, path: entry.path, module });
                    }
                }
            }
        });

        references.sort((a, b) => a.path.localeCompare(b.path));
        importers.sort((a, b) => a.path.localeCompare(b.path));
        return {
            definitions,
            references: references.slice(0, MAX_REFERENCE_FILES),
            importers: importers.slice(0, MAX_REFERENCE_FILES),
            totalFiles: references.length,
            searched,
            unindexed,
        };
    }

    /** `src/jobs/nightly.py`, `src.jobs.nightly`, `./nightly` and `nightly` all name the module `nightly`. */
    private static moduleBasename(module: string): string {
        const trimmed = module.trim().replace(/\.(py|js|ts|tsx|jsx|mjs|cjs)$/, "");
        const segments = trimmed.split(/[./\\]+/).filter(Boolean);
        return (segments.at(-1) ?? trimmed).toLowerCase();
    }

    /** Runs `visit` over every symbol index in scope, reporting which repositories had one. */
    private async forEachIndex(
        scope: LookupScope,
        visit: (projectSlug: string, repo: string, index: SymbolIndex) => void,
    ): Promise<{ searched: string[]; unindexed: string[] }> {
        const searched: string[] = [];
        const unindexed: string[] = [];
        for (const { projectSlug, repo } of await this.scopedRepositories(scope)) {
            const index = await this.loadSymbols(projectSlug, repo.folder);
            const name = repoFullName(repo);
            if (!index) {
                unindexed.push(name);
                continue;
            }
            searched.push(name);
            visit(projectSlug, name, index);
        }
        return { searched, unindexed };
    }

    private async scopedRepositories(scope: LookupScope): Promise<Array<{ projectSlug: string; repo: RegistryRepo }>> {
        const projects = scope.project ? [scope.project] : (await this.registry.load()).projects.map((p) => p.slug);
        const wanted = scope.repo?.trim().toLowerCase();
        const result: Array<{ projectSlug: string; repo: RegistryRepo }> = [];
        for (const projectSlug of projects) {
            for (const repo of await this.repositories(projectSlug)) {
                if (wanted && !CodeIndexService.namesOf(repo).includes(wanted)) continue;
                result.push({ projectSlug, repo });
            }
        }
        return result;
    }
}
