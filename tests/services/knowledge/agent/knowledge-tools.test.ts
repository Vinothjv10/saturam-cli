import {
    KNOWLEDGE_TOOL_DEFINITIONS,
    KnowledgeToolExecutor,
    MAX_READS_PER_QUESTION,
} from "../../../../src/services/knowledge/agent/knowledge-tools";

const codeChunk = {
    content: "def run():\n    return os.getenv('JOBS_TABLE')",
    location: "s3://kb/onboarding/orion/bitbucket/orion-core/jobs/nightly.py.md",
    score: 0.6,
    metadata: {
        project: "orion",
        title: "orion-core/jobs/nightly.py",
        source: "bitbucket",
        category: "bitbucket",
        repo: "acme/orion-core",
        path: "jobs/nightly.py",
    },
};

const docChunk = {
    content: "The nightly job runs at 01:30.",
    location: "s3://kb/onboarding/orion/google-docs/12-jobs.md",
    score: 0.5,
    metadata: { project: "orion", title: "12-jobs", source: "google-docs", category: "google-docs" },
};

const repo = { workspace: "acme", repoSlug: "orion-core", folder: "orion-core", branch: "main", documentCount: 4 };

const index = {
    projectSlug: "orion",
    folder: "orion-core",
    workspace: "acme",
    repoSlug: "orion-core",
    fullName: "acme/orion-core",
    branch: "main",
    commit: "3f2a9c1deadbeef0123456789abcdef012345678",
    complete: true,
    paths: ["README.md", "jobs/nightly.py", "jobs/utils/io.py"],
};

const project = {
    slug: "orion",
    displayName: "Orion",
    aliases: [],
    documentCount: 555,
    sources: ["bitbucket", "google-docs"],
    counts: { "google-docs": 24, bitbucket: 531 },
    repos: [repo],
};

describe("KnowledgeToolExecutor", () => {
    let knowledgeBase: any;
    let registry: any;
    let reader: any;
    let codeIndex: any;
    let executor: KnowledgeToolExecutor;

    const run = (name: string, args: Record<string, unknown> = {}) => executor.run({ id: "c1", name, args });

    beforeEach(() => {
        knowledgeBase = { retrieve: jest.fn().mockResolvedValue([codeChunk, docChunk]) };
        registry = { load: jest.fn().mockResolvedValue({ projects: [project] }) };
        reader = {
            documentIdOf: jest.fn(async (location?: string) => location?.replace("s3://kb/onboarding/", "")),
            read: jest.fn().mockResolvedValue({
                key: "orion/bitbucket/orion-core/jobs/nightly.py.md",
                path: "jobs/nightly.py",
                content: "1 | def run():",
                identifiers: ["jobs/nightly.py", "orion/bitbucket/orion-core/jobs/nightly.py.md"],
            }),
        };
        codeIndex = {
            repositories: jest.fn().mockResolvedValue([repo]),
            find: jest.fn().mockResolvedValue(index),
            listDirectory: jest.fn().mockReturnValue({
                directory: "jobs",
                subdirectories: [{ name: "utils", files: 1 }],
                files: ["nightly.py"],
                omitted: 0,
            }),
        };
        executor = new KnowledgeToolExecutor(knowledgeBase, registry, reader, codeIndex, []);
    });

    it("offers search, read, browse, list and recall", () => {
        expect(KNOWLEDGE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
            "search_documentation",
            "read_document",
            "browse_repository",
            "list_projects",
            "recall_conversation",
        ]);
    });

    describe("search_documentation", () => {
        it("searches everything when no kind is given, with no filter at all", async () => {
            await run("search_documentation", { query: "nightly job" });

            const [, options] = knowledgeBase.retrieve.mock.calls[0];
            expect(options).toEqual({ numberOfResults: 12 });
        });

        it("narrows to code through the category, and to one repository", async () => {
            await run("search_documentation", { query: "nightly job", kind: "code" });
            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ category: "bitbucket" }),
            );

            await run("search_documentation", { query: "nightly job", repo: "acme/orion-core" });
            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ repo: "acme/orion-core", category: "bitbucket" }),
            );
        });

        it("narrows to prose by excluding the code category", async () => {
            await run("search_documentation", { query: "nightly job", kind: "docs", project: "orion" });

            expect(knowledgeBase.retrieve).toHaveBeenLastCalledWith(
                "nightly job",
                expect.objectContaining({ project: "orion", excludeCategory: "bitbucket" }),
            );
        });

        it("rejects an unknown kind without searching", async () => {
            const reply = await run("search_documentation", { query: "nightly job", kind: "tests" });

            expect(reply).toContain("`kind` must be one of");
            expect(knowledgeBase.retrieve).not.toHaveBeenCalled();
        });

        it("labels code results with repo:path and gives every result a document id", async () => {
            const reply = await run("search_documentation", { query: "nightly job" });

            expect(reply).toContain("[1] orion · orion-core/jobs/nightly.py · code · acme/orion-core:jobs/nightly.py");
            expect(reply).toContain("document: orion/bitbucket/orion-core/jobs/nightly.py.md");
            expect(reply).toContain("[2] orion · 12-jobs · google-docs");
            expect(reply).toContain("document: orion/google-docs/12-jobs.md");
        });

        it("remembers the titles, paths and repositories of results as names it saw", async () => {
            await run("search_documentation", { query: "nightly job" });

            expect(executor.knownIdentifiers).toEqual(
                expect.arrayContaining(["jobs/nightly.py", "acme/orion-core", "orion-core/jobs/nightly.py", "12-jobs"]),
            );
        });

        it("says what scope an empty search had, so the agent can widen it", async () => {
            knowledgeBase.retrieve.mockResolvedValue([]);

            const reply = await run("search_documentation", { query: "billing", kind: "code", project: "orion" });

            expect(reply).toContain('No passages matched "billing" within project "orion" and kind "code"');
        });
    });

    describe("read_document", () => {
        it("reads through the reader and records what it saw", async () => {
            const reply = await run("read_document", { document: "acme/orion-core:jobs/nightly.py" });

            expect(reader.read).toHaveBeenCalledWith("acme/orion-core:jobs/nightly.py", {
                startLine: undefined,
                endLine: undefined,
            });
            expect(reply).toBe("1 | def run():");
            expect(executor.readCount).toBe(1);
            expect(executor.knownIdentifiers).toContain("jobs/nightly.py");
        });

        it("passes a line range through", async () => {
            await run("read_document", { document: "orion/google-docs/12-jobs.md", startLine: 10, endLine: 20 });

            expect(reader.read).toHaveBeenCalledWith("orion/google-docs/12-jobs.md", { startLine: 10, endLine: 20 });
        });

        it("reports a failed read to the agent rather than failing the question", async () => {
            reader.read.mockRejectedValue(new Error('There is no document at "x".'));

            const reply = await run("read_document", { document: "x" });

            expect(reply).toContain('Could not read "x": There is no document at "x".');
        });

        it("stops at the read budget and says so", async () => {
            for (let i = 0; i < MAX_READS_PER_QUESTION; i += 1) {
                await run("read_document", { document: "orion/google-docs/12-jobs.md" });
            }

            const reply = await run("read_document", { document: "orion/google-docs/12-jobs.md" });

            expect(reply).toContain("read budget");
            expect(reader.read).toHaveBeenCalledTimes(MAX_READS_PER_QUESTION);
        });

        it("requires a document reference", async () => {
            expect(await run("read_document", {})).toContain("`document` argument is required");
        });
    });

    describe("browse_repository", () => {
        it("lists a project's repositories when none is named", async () => {
            codeIndex.repositories.mockResolvedValue([repo, { ...repo, repoSlug: "orion-ui", folder: "orion-ui" }]);

            const reply = await run("browse_repository", { project: "orion" });

            expect(reply).toContain('Repositories indexed for project "orion"');
            expect(reply).toContain("- acme/orion-core @ main, 4 file(s)");
            expect(reply).toContain("- acme/orion-ui @ main");
            expect(executor.knownIdentifiers).toContain("acme/orion-core");
        });

        it("lists one directory with sub-directory counts, and says how to read a file", async () => {
            const reply = await run("browse_repository", { project: "orion", repo: "orion-core", directory: "jobs" });

            expect(codeIndex.find).toHaveBeenCalledWith("orion", "orion-core");
            expect(codeIndex.listDirectory).toHaveBeenCalledWith(index, "jobs");
            expect(reply).toContain("acme/orion-core/jobs/ — branch main, commit 3f2a9c1deadb");
            expect(reply).toContain("utils/  (1 file(s))");
            expect(reply).toContain("  nightly.py");
            expect(reply).toContain('read_document("acme/orion-core:<path>")');
            expect(executor.knownIdentifiers).toEqual(expect.arrayContaining(["jobs/nightly.py", "jobs/utils"]));
        });

        it("falls through to the only repository when a directory is given without a repo", async () => {
            await run("browse_repository", { project: "orion", directory: "jobs" });

            expect(codeIndex.find).toHaveBeenCalledWith("orion", "orion-core");
        });

        it("names the repositories when the one asked for does not exist", async () => {
            codeIndex.find.mockResolvedValue(undefined);

            const reply = await run("browse_repository", { project: "orion", repo: "nowhere" });

            expect(reply).toContain('no repository called "nowhere"');
            expect(reply).toContain("acme/orion-core");
        });

        it("says so when a project has no indexed code", async () => {
            codeIndex.repositories.mockResolvedValue([]);

            expect(await run("browse_repository", { project: "orion" })).toContain(
                "No source repositories are indexed",
            );
        });

        it("requires a project", async () => {
            expect(await run("browse_repository", {})).toContain("`project` argument is required");
        });
    });

    describe("list_projects", () => {
        it("renders the per-category counts and the repositories", async () => {
            const reply = await run("list_projects");

            expect(reply).toContain("Orion [slug: orion, 555 document(s) (24 google-docs, 531 code)]");
            expect(reply).toContain("repositories: acme/orion-core @ main");
        });
    });
});
