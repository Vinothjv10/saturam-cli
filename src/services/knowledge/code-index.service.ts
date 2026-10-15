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

/** Entries shown per directory listing; a flat directory of thousands of files is summarised past this. */
export const MAX_LISTED_ENTRIES = 200;

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

/**
 * Reads the pipeline's per-repository index so the agent can see a repository as a tree.
 *
 * Retrieval answers "which passages resemble this question"; it cannot answer "what is in this
 * directory" or "does this file exist", and an agent that cannot ask those questions guesses at
 * paths. The pipeline already records every key it wrote for a repository, so the tree costs one
 * small object read, and every path it yields is one the agent can go on to read.
 */
@Service()
export class CodeIndexService {
    private readonly cache = new Map<string, { index: RepoIndex; loadedAt: number }>();

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
                .filter((folder): folder is string => Boolean(folder));
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
        const match = repos.find((repo) =>
            [repo.folder, repo.repoSlug, repoFullName(repo)].some((name) => name.toLowerCase() === wanted),
        );
        if (match) return this.load(projectSlug, match.folder);
        // A registry that predates repository listing has no folders to match; the folder name is the slug.
        return repos.length === 0
            ? this.load(projectSlug, wanted.includes("/") ? wanted.split("/")[1] : wanted)
            : undefined;
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
}
