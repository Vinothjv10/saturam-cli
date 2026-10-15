import { CodeIndexService } from "../../../src/services/knowledge/code-index.service";

const state = {
    workspace: "acme",
    repoSlug: "orion-core",
    branch: "main",
    commit: "3f2a9c1deadbeef0123456789abcdef012345678",
    indexedAt: "2026-10-14T15:57:16Z",
    version: 2,
    planned: 4,
    complete: true,
    keys: [
        "orion/bitbucket/orion-core/_repository.md",
        "orion/bitbucket/orion-core/README.md.md",
        "orion/bitbucket/orion-core/jobs/nightly.py.md",
        "orion/bitbucket/orion-core/jobs/utils/io.py.md",
        "orion/bitbucket/orion-core/infra/main.tf.md",
    ],
};

const registered = {
    workspace: "acme",
    repoSlug: "orion-core",
    folder: "orion-core",
    branch: "main",
    documentCount: 5,
};

describe("CodeIndexService", () => {
    let s3: any;
    let registry: any;
    let service: CodeIndexService;

    beforeEach(() => {
        s3 = {
            getStateObject: jest.fn().mockResolvedValue(Buffer.from(JSON.stringify(state))),
            listStateObjects: jest.fn().mockResolvedValue(["onboarding-state/code-index/orion/orion-core.json"]),
        };
        registry = { reposOf: jest.fn().mockResolvedValue([registered]) };
        service = new CodeIndexService(s3, registry);
    });

    it("lists a project's repositories from the registry without touching S3", async () => {
        await expect(service.repositories("orion")).resolves.toEqual([registered]);
        expect(s3.listStateObjects).not.toHaveBeenCalled();
    });

    it("falls back to listing the state prefix for a registry that predates repositories", async () => {
        registry.reposOf.mockResolvedValue([]);

        const repos = await service.repositories("orion");

        expect(s3.listStateObjects).toHaveBeenCalledWith("code-index/orion");
        expect(repos).toMatchObject([
            { workspace: "acme", repoSlug: "orion-core", folder: "orion-core", documentCount: 4 },
        ]);
    });

    it("loads a repository's files from the state file, dropping the pipeline's own index document", async () => {
        const index = await service.load("orion", "orion-core");

        expect(s3.getStateObject).toHaveBeenCalledWith("code-index/orion/orion-core.json");
        expect(index).toMatchObject({ fullName: "acme/orion-core", branch: "main", complete: true });
        expect(index?.paths).toEqual(["README.md", "infra/main.tf", "jobs/nightly.py", "jobs/utils/io.py"]);
    });

    it("finds a repository by slug, folder or full name, in any case", async () => {
        await expect(service.find("orion", "ACME/orion-core")).resolves.toMatchObject({ folder: "orion-core" });
        await expect(service.find("orion", "orion-core")).resolves.toMatchObject({ folder: "orion-core" });
        await expect(service.find("orion", "nowhere")).resolves.toBeUndefined();
    });

    it("lists one level of the tree, with a file count under each sub-directory", async () => {
        const index = (await service.load("orion", "orion-core"))!;

        const root = service.listDirectory(index);
        expect(root.subdirectories).toEqual([
            { name: "infra", files: 1 },
            { name: "jobs", files: 2 },
        ]);
        expect(root.files).toEqual(["README.md"]);

        const jobs = service.listDirectory(index, "jobs/");
        expect(jobs).toMatchObject({
            directory: "jobs",
            subdirectories: [{ name: "utils", files: 1 }],
            files: ["nightly.py"],
        });
    });

    it("caches an index so a conversation does not re-read the state file on every call", async () => {
        await service.load("orion", "orion-core");
        await service.load("orion", "orion-core");

        expect(s3.getStateObject).toHaveBeenCalledTimes(1);
    });

    it("is undefined when there is no state file, rather than throwing into the agent", async () => {
        s3.getStateObject.mockRejectedValue(new Error("NoSuchKey"));

        await expect(service.load("orion", "orion-core")).resolves.toBeUndefined();
    });
});
