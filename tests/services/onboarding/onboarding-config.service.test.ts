import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OnboardingConfigService } from "../../../src/services/onboarding/onboarding-config.service";
import { ConfigService } from "../../../src/services/config-service";
import { WorkingDirectory } from "../../../src/utils/working-directory";

describe("OnboardingConfigService", () => {
    let tmpDir: string;
    let service: OnboardingConfigService;
    let configService: ConfigService;
    let dir: WorkingDirectory;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sateng-onboarding-config-"));
        dir = new WorkingDirectory(tmpDir, tmpDir, tmpDir);
        configService = new ConfigService(dir);
        service = new OnboardingConfigService(configService, dir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("configPath / localConfigExists", () => {
        it("resolves under <repoRoot>/.sateng/onboarding.json", () => {
            expect(service.configPath).toBe(path.join(tmpDir, ".sateng", "onboarding.json"));
            expect(service.localConfigExists()).toBe(false);
        });

        it("reports true once the file exists", () => {
            fs.mkdirSync(path.join(tmpDir, ".sateng"), { recursive: true });
            fs.writeFileSync(service.configPath, "{}");
            expect(service.localConfigExists()).toBe(true);
        });
    });

    describe("isLocalConfigHandWritten", () => {
        it("is false when no local file exists", () => {
            expect(service.isLocalConfigHandWritten()).toBe(false);
        });

        it("is true for a local file with no _sourceGoogleSheetId marker", () => {
            fs.mkdirSync(path.join(tmpDir, ".sateng"), { recursive: true });
            fs.writeFileSync(service.configPath, JSON.stringify({ confluence: { baseUrl: "https://hand-written" } }));
            expect(service.isLocalConfigHandWritten()).toBe(true);
        });

        it("is false for a local file generated from a sheet (has the marker)", () => {
            service.saveResolvedConfig({ projects: {} }, "sheet-abc");
            expect(service.isLocalConfigHandWritten()).toBe(false);
        });
    });

    describe("resolveConfigArgPath", () => {
        it("resolves a relative arg against the working directory's cwd, not the repo root", () => {
            const otherDir = new WorkingDirectory("/mock/user/cwd", "/mock/cli", "/mock/repo");
            const otherService = new OnboardingConfigService(new ConfigService(otherDir), otherDir);
            expect(otherService.resolveConfigArgPath("./team.json")).toBe(
                path.resolve("/mock/user/cwd", "./team.json"),
            );
        });
    });

    describe("parseSheetArg", () => {
        it("extracts the spreadsheet ID from a docs.google.com URL", () => {
            expect(service.parseSheetArg("https://docs.google.com/spreadsheets/d/abc123/edit")).toBe("abc123");
        });

        it("accepts a raw 44-character sheet ID", () => {
            const id = "a".repeat(44);
            expect(service.parseSheetArg(id)).toBe(id);
        });

        it("accepts sheet IDs of other lengths too, since Drive ID length isn't a fixed contract", () => {
            expect(service.parseSheetArg("a".repeat(28))).toBe("a".repeat(28));
            expect(service.parseSheetArg("a".repeat(60))).toBe("a".repeat(60));
        });

        it("returns null for a file path, even one long enough to otherwise match", () => {
            expect(service.parseSheetArg("./local-config.json")).toBeNull();
            expect(service.parseSheetArg("/absolute/path/to/some-config-file.json")).toBeNull();
        });

        it("returns null for anything else", () => {
            expect(service.parseSheetArg("too-short")).toBeNull();
        });
    });

    describe("writeSampleConfig", () => {
        it("writes a sample onboarding.json when none exists", () => {
            service.writeSampleConfig();

            const written = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(written.confluence.baseUrl).toBeTruthy();
            expect(written.jira.baseUrl).toBeTruthy();
            expect(written.projects.ExampleProject.confluence.pages).toEqual(["123456789"]);
        });

        it("never overwrites an existing onboarding.json, writing onboarding.sample.json instead", () => {
            fs.mkdirSync(path.join(tmpDir, ".sateng"), { recursive: true });
            fs.writeFileSync(service.configPath, JSON.stringify({ confluence: { baseUrl: "https://existing" } }));

            service.writeSampleConfig();

            const existingAfter = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(existingAfter.confluence.baseUrl).toBe("https://existing");
            expect(fs.existsSync(path.join(tmpDir, ".sateng", "onboarding.sample.json"))).toBe(true);
        });
    });

    describe("saveResolvedConfig", () => {
        const config = { projects: { Saturam: { jira: { tickets: ["PROJ-1"] } } } };

        it("writes the resolved config plus a _sourceGoogleSheetId marker when no local file exists", () => {
            service.saveResolvedConfig(config, "sheet-abc");

            const written = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(written._sourceGoogleSheetId).toBe("sheet-abc");
            expect(written.projects).toEqual(config.projects);
        });

        it("overwrites a local file that was itself generated from a sheet", () => {
            service.saveResolvedConfig(config, "sheet-abc");
            const updated = { projects: { Saturam: { jira: { tickets: ["NEW-1"] } } } };

            service.saveResolvedConfig(updated, "sheet-abc");

            const written = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(written.projects.Saturam.jira.tickets).toEqual(["NEW-1"]);
        });

        it("refuses to overwrite a hand-written local file with no _sourceGoogleSheetId marker", () => {
            fs.mkdirSync(path.join(tmpDir, ".sateng"), { recursive: true });
            fs.writeFileSync(service.configPath, JSON.stringify({ confluence: { baseUrl: "https://hand-written" } }));

            service.saveResolvedConfig(config, "sheet-abc");

            const written = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(written.confluence.baseUrl).toBe("https://hand-written");
            expect(written._sourceGoogleSheetId).toBeUndefined();
        });

        it("overwrites a hand-written local file when force is true", () => {
            fs.mkdirSync(path.join(tmpDir, ".sateng"), { recursive: true });
            fs.writeFileSync(service.configPath, JSON.stringify({ confluence: { baseUrl: "https://hand-written" } }));

            service.saveResolvedConfig(config, "sheet-abc", true);

            const written = JSON.parse(fs.readFileSync(service.configPath, "utf-8"));
            expect(written._sourceGoogleSheetId).toBe("sheet-abc");
        });
    });
});
